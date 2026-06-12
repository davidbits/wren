/**
 * `wren enable <path>` — opt a project in.
 *
 * Dual opt-in (D15): writes the central registry (`projects.toml`, the
 * source of truth the worker/hooks re-check) AND the agent's native per-project
 * config — Claude `.claude/settings.local.json` hooks and (with `--codex`) the
 * Codex `<project>/.codex/config.toml` Stop hook. Codex is opt-in because it
 * also seeds a project-trust entry in the global `~/.codex/config.toml`.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type Config,
  ensureDirs,
  loadProjects,
  normalizePath,
  type ProjectRegistry,
  saveProjects,
} from "../config.ts";
import { logger } from "../util/log.ts";
import { writeCodexConfig } from "./codex-config.ts";
import { CLAUDE_CAPTURE, CLAUDE_INJECT, selfCommandString } from "./integration.ts";

const log = logger("enable");

interface ClaudeHookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string; async?: boolean; timeout?: number }>;
}
interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookEntry[]>;
  [k: string]: unknown;
}

function hasCommand(entries: ClaudeHookEntry[] | undefined, command: string): boolean {
  return !!entries?.some((e) => e.hooks.some((h) => h.command === command));
}

function addHook(
  settings: ClaudeSettings,
  event: string,
  command: string,
  opts: { async?: boolean } = {},
): boolean {
  settings.hooks ??= {};
  settings.hooks[event] ??= [];
  if (hasCommand(settings.hooks[event], command)) return false;
  settings.hooks[event].push({
    hooks: [{ type: "command", command, timeout: 15, ...opts }],
  });
  return true;
}

async function writeClaudeHooks(projectPath: string): Promise<string[]> {
  const dir = join(projectPath, ".claude");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "settings.local.json");
  const existing = Bun.file(file);
  const settings: ClaudeSettings = (await existing.exists())
    ? ((await existing.json()) as ClaudeSettings)
    : {};

  const changes: string[] = [];
  if (addHook(settings, "SessionEnd", selfCommandString("hook", CLAUDE_CAPTURE), { async: true })) {
    changes.push("SessionEnd → capture");
  }
  if (addHook(settings, "SessionStart", selfCommandString("hook", CLAUDE_INJECT))) {
    changes.push("SessionStart → inject");
  }
  // Bypass Claude Code's native auto-memory in opted-in projects: the vault is
  // the single source of truth (D4), so the agent should not keep a second,
  // diverging store under ~/.claude/.../memory. This only stops auto-memory
  // read/write — user-authored CLAUDE.md is a separate setting and is untouched.
  if (settings.autoMemoryEnabled !== false) {
    settings.autoMemoryEnabled = false;
    changes.push("autoMemoryEnabled=false (native memory off)");
  }
  if (changes.length) await Bun.write(file, `${JSON.stringify(settings, null, 2)}\n`);
  return changes;
}

export interface EnableOptions {
  codex?: boolean;
}

export async function enableProject(
  cfg: Config,
  rawPath: string,
  opts: EnableOptions = {},
): Promise<void> {
  const path = normalizePath(rawPath);
  await ensureDirs(cfg);

  // 1. Central registry (source of truth).
  const reg: ProjectRegistry = await loadProjects(cfg);
  reg.projects[path] = { enabled: true, added: new Date().toISOString() };
  await saveProjects(cfg, reg);
  log.info("registry updated", { path });
  console.log(`✓ enabled in registry: ${path}`);

  // 2. Claude per-project hooks.
  const claudeChanges = await writeClaudeHooks(path);
  if (claudeChanges.length) {
    console.log(
      `✓ Claude hooks written (.claude/settings.local.json): ${claudeChanges.join(", ")}`,
    );
  } else {
    console.log("• Claude hooks already present");
  }

  // 3. Codex (opt-in): Stop hook in <project>/.codex/config.toml, trust in global.
  if (opts.codex) {
    const codexChanges = await writeCodexConfig(path);
    console.log(`✓ Codex config updated: ${codexChanges.join(", ")}`);
    if (codexChanges.includes("Stop hook (hooks.json)")) {
      console.log(
        `  → wrote ${join(path, ".codex", "hooks.json")} — gitignore it (embeds a\n` +
          "    machine-specific binary path).\n" +
          "  → trust the capture hook in Codex: run /hooks and approve it\n" +
          "    (Codex hash-pins command hooks; it won't fire until trusted).",
      );
    }
  }

  console.log("\nDone. New sessions in this project will be captured.");
}

export async function disableProject(cfg: Config, rawPath: string): Promise<void> {
  const path = normalizePath(rawPath);
  const reg = await loadProjects(cfg);
  if (reg.projects[path]) {
    reg.projects[path] = { ...reg.projects[path]!, enabled: false };
    await saveProjects(cfg, reg);
    console.log(`✓ disabled: ${path}`);
  } else {
    console.log(`• not in registry: ${path}`);
  }
  console.log("Note: agent hook config left in place; it re-checks the registry and now no-ops.");
}
