/**
 * Codex config writer.
 *
 * Capture wiring is **per-project**, mirroring the Claude path
 * (`.claude/settings.local.json`):
 *   - Stop hook  → `<project>/.codex/hooks.json`     (project-local layer)
 *   - project trust → `~/.codex/config.toml [projects."<path>"]`
 *
 * Install-time Codex setup is **home-wide**:
 *   - MCP server + native memory off → `~/.codex/config.toml`
 *   - SessionStart memory reminder   → `~/.codex/hooks.json`
 *
 * Hooks go in `hooks.json`, not `config.toml`: Codex loads a layer's hooks from
 * *either* file, and having them in both for one layer triggers a "prefer a
 * single representation for this layer" warning. `hooks.json` is the canonical
 * home and keeps our hook out of any `config.toml` the project already maintains.
 *
 * Trust still lives in the *global* `config.toml` because that is what makes
 * Codex load the project's `.codex/` layer at all (untrusted projects skip
 * project-local config + hooks). Global config.toml vs project hooks.json are
 * different layers/files, so no split warning.
 *
 * Two caveats remain:
 *   1. Project-local command hooks are hash-pinned — approve via `/hooks` before
 *      they fire.
 *   2. The hook command embeds an absolute path to this machine's wren
 *      binary, so `<project>/.codex/hooks.json` is machine-specific — gitignore
 *      it rather than committing it.
 *
 * We back up any file before rewriting it (smol-toml does not preserve comments).
 */
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { logger } from "../util/log.ts";
import { CODEX_CAPTURE, selfCommand, selfCommandString } from "./integration.ts";

const log = logger("codex-config");
const SESSION_START_MATCHER = "startup|resume";
const MEMORY_REMINDER = "echo 'Use wren mcp server to retrieve memories and learnings from Vault.'";

/** Documented Codex hook handler — `command` is a single shell string. */
interface CommandHandler {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
}
interface HookGroup {
  matcher?: string;
  hooks: CommandHandler[];
}
interface CodexHooksFile {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}
/** Legacy project config.toml may carry a `[hooks]` table from older versions. */
interface CodexConfigToml {
  projects?: Record<string, Record<string, unknown>>;
  hooks?: { Stop?: Array<{ command?: string[] | string }>; [k: string]: unknown };
  mcp_servers?: Record<string, unknown>;
  features?: { memories?: boolean; [k: string]: unknown };
  [k: string]: unknown;
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/** Global Codex config — user-level layer (trust + MCP servers). */
function globalConfigPath(codexHome = defaultCodexHome()): string {
  return join(codexHome, "config.toml");
}
function globalHooksJsonPath(): string {
  return join(defaultCodexHome(), "hooks.json");
}
function projectConfigTomlPath(projectPath: string): string {
  return join(projectPath, ".codex", "config.toml");
}
function projectHooksJsonPath(projectPath: string): string {
  return join(projectPath, ".codex", "hooks.json");
}

/** Single shell-string form of our capture invocation, as Codex hooks expect. */
function captureCommand(): string {
  return selfCommandString("hook", CODEX_CAPTURE);
}

function memoryReminderCommand(): CommandHandler {
  return {
    type: "command",
    command: MEMORY_REMINDER,
    timeout: 5,
    statusMessage: "Loading wren memory",
  };
}

function addSessionStartMemoryHook(file: CodexHooksFile): boolean {
  file.hooks ??= {};
  file.hooks.SessionStart ??= [];
  const present = file.hooks.SessionStart.some((g) =>
    g.hooks?.some((h) => h.command === MEMORY_REMINDER),
  );
  if (present) return false;

  const startupGroup = file.hooks.SessionStart.find((g) => g.matcher === SESSION_START_MATCHER);
  if (startupGroup) {
    startupGroup.hooks.push(memoryReminderCommand());
  } else {
    file.hooks.SessionStart.push({
      matcher: SESSION_START_MATCHER,
      hooks: [memoryReminderCommand()],
    });
  }
  return true;
}

async function readToml<T>(path: string): Promise<T> {
  const file = Bun.file(path);
  return ((await file.exists()) ? (parse(await file.text()) as T) : ({} as T)) as T;
}
async function readJson<T>(path: string): Promise<T> {
  const file = Bun.file(path);
  return ((await file.exists()) ? ((await file.json()) as T) : ({} as T)) as T;
}

/** Back up a config before a rewrite (no-op if absent). */
async function backup(path: string): Promise<void> {
  if (await Bun.file(path).exists()) await copyFile(path, `${path}.wren.bak`);
}
async function writeBackedUp(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await backup(path);
  await Bun.write(path, body);
}

/**
 * Wire Codex capture for one project: Stop hook in the project `hooks.json`,
 * trust in every supplied Codex home's global config. Migrates away any Stop
 * hook a prior version wrote into the project `config.toml`. Returns the list
 * of changes.
 */
export async function writeCodexConfig(
  projectPath: string,
  codexHomes: string[] = [defaultCodexHome()],
): Promise<string[]> {
  const changes: string[] = [];
  const cmd = captureCommand();

  // 1. Project trust → each global config.toml. Trust gates whether that Codex
  //    home loads the project's `.codex/` layer (and therefore the Stop hook).
  const homes = [...new Set(codexHomes.length ? codexHomes : [defaultCodexHome()])];
  for (const codexHome of homes) {
    const globalPath = globalConfigPath(codexHome);
    const global = await readToml<CodexConfigToml>(globalPath);
    global.projects ??= {};
    if (global.projects[projectPath]?.trust_level !== "trusted") {
      global.projects[projectPath] = { ...global.projects[projectPath], trust_level: "trusted" };
      await writeBackedUp(globalPath, stringify(global as Record<string, unknown>));
      changes.push(`project trust (${codexHome})`);
    }
  }

  // 2. Stop hook → project hooks.json (canonical hook location).
  const hooksPath = projectHooksJsonPath(projectPath);
  const file = await readJson<CodexHooksFile>(hooksPath);
  file.hooks ??= {};
  file.hooks.Stop ??= [];
  let hooksChanged = false;
  const present = file.hooks.Stop.some((g) => g.hooks?.some((h) => h.command === cmd));
  if (!present) {
    file.hooks.Stop.push({ hooks: [{ type: "command", command: cmd, timeout: 30 }] });
    hooksChanged = true;
    changes.push("Stop hook (hooks.json)");
  }
  if (addSessionStartMemoryHook(file)) {
    hooksChanged = true;
    changes.push("SessionStart hook (hooks.json)");
  }
  if (hooksChanged) {
    await writeBackedUp(hooksPath, `${JSON.stringify(file, null, 2)}\n`);
  }

  // 3. Migrate: drop our Stop hook from the project config.toml if an older
  //    version put it there — leaving both would trip Codex's split-layer warning.
  if (await removeStopFromConfigToml(projectConfigTomlPath(projectPath), cmd)) {
    changes.push("removed legacy config.toml hook");
  }

  if (changes.length) log.info("codex config written", { project: projectPath, changes });
  return changes.length ? changes : ["no changes"];
}

/** Strip our capture command from a project config.toml `[hooks].Stop`. Returns true if changed. */
async function removeStopFromConfigToml(path: string, cmd: string): Promise<boolean> {
  if (!(await Bun.file(path).exists())) return false;
  const cfg = await readToml<CodexConfigToml>(path);
  const stop = cfg.hooks?.Stop;
  if (!stop?.length) return false;

  const kept = stop.filter((h) => {
    const c = Array.isArray(h.command) ? h.command.join(" ") : h.command;
    return c !== cmd;
  });
  if (kept.length === stop.length) return false; // nothing of ours present

  if (kept.length) cfg.hooks!.Stop = kept;
  else delete cfg.hooks!.Stop;
  if (cfg.hooks && Object.keys(cfg.hooks).length === 0) delete cfg.hooks;

  await writeBackedUp(path, stringify(cfg as Record<string, unknown>));
  return true;
}

/**
 * Register the MCP server in the *global* Codex config (`[mcp_servers.wren]`)
 * and bypass Codex's native memory summarizer (`[features] memories = false`).
 * Both stay user-level — the Codex analogue of `claude mcp add --scope user`,
 * not a per-project concern.
 *
 * We disable native memory because the vault is the single source of truth (D4):
 * leaving Codex's own summarizer on means a second, diverging memory store plus
 * a duplicate per-session extraction cost. User-authored `AGENTS.md` is a
 * separate mechanism and is untouched. We also add a SessionStart hook that
 * reminds Codex to use the Wren MCP server, so installed systems load vault
 * memories automatically at session start.
 */
export async function writeCodexMcp(): Promise<string[]> {
  const path = globalConfigPath();
  const cfg = await readToml<CodexConfigToml>(path);
  const changes: string[] = [];

  cfg.mcp_servers ??= {};
  const [command, ...rest] = selfCommand();
  cfg.mcp_servers.wren = { command, args: [...rest, "mcp"] };
  changes.push("mcp_servers.wren");

  cfg.features ??= {};
  if (cfg.features.memories !== false) {
    cfg.features.memories = false;
    changes.push("features.memories=false (native memory off)");
  }

  await writeBackedUp(path, stringify(cfg as Record<string, unknown>));

  if (await writeGlobalSessionStartHook()) {
    changes.push("SessionStart hook (global hooks.json)");
  }

  return changes;
}

async function writeGlobalSessionStartHook(): Promise<boolean> {
  const path = globalHooksJsonPath();
  const file = await readJson<CodexHooksFile>(path);
  if (!addSessionStartMemoryHook(file)) return false;
  await writeBackedUp(path, `${JSON.stringify(file, null, 2)}\n`);
  return true;
}
