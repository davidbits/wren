/**
 * Configuration + the opt-in project registry.
 *
 * Two files live under `~/.config/wren/`:
 *   - `config.toml`   — global settings (vault path, extractor model, ...).
 *   - `projects.toml` — the source-of-truth registry of opt-in projects (D15).
 *
 * Everything else (paths to the queue, index, vault subfolders) is derived from
 * these so the rest of the codebase imports one resolved {@link Config}.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { parse, stringify } from "smol-toml";

export interface Config {
  /** `~/.config/wren` (override with `WREN_CONFIG_DIR`). */
  configDir: string;
  /** `~/.local/share/wren` — queue + derived index live here. */
  dataDir: string;
  /** Obsidian vault root (source of truth). */
  vaultPath: string;
  /** Durable file-per-job queue directory. */
  queueDir: string;
  /** SQLite FTS5 derived index. */
  indexDbPath: string;
  /** Path to the Codex binary used by the extractor (D6). */
  codexBin: string;
  /**
   * Codex home — the directory whose `sessions/` tree wren reads transcripts
   * from. Defaults to `$CODEX_HOME` or `~/.codex`; a machine can have several,
   * so `wren codex-home` detects them and persists the chosen one here.
   */
  codexHome: string;
  /** Optional `-m` model override for `codex exec`. */
  extractorModel?: string;
  /** Hard cap on memories injected at SessionStart (keeps context cheap). */
  maxInject: number;
  /**
   * Quiet period (ms) a transcript must be idle before a Codex job is extracted.
   * Codex `Stop` fires per-turn with no session-end event, so we infer end-of-
   * session from inactivity (trailing debounce). Claude jobs ignore this.
   */
  settleMs: number;
  /** Minimum delay between revisions of the same Codex session. */
  codexRecaptureMs: number;
  /** When true the extractor uses a local heuristic instead of Codex (offline/testing). */
  fakeExtractor: boolean;
}

/** Per-project registry entry. */
export interface ProjectEntry {
  enabled: boolean;
  added: string;
}

export interface ProjectRegistry {
  projects: Record<string, ProjectEntry>;
}

function configDir(): string {
  return process.env.WREN_CONFIG_DIR ?? join(homedir(), ".config", "wren");
}

function dataDir(): string {
  return process.env.WREN_DATA_DIR ?? join(homedir(), ".local", "share", "wren");
}

/** Raw shape of `config.toml` (all optional; defaults applied in {@link loadConfig}). */
interface RawConfig {
  vault_path?: string;
  data_dir?: string;
  codex_bin?: string;
  codex_home?: string;
  extractor_model?: string;
  max_inject?: number;
  settle_ms?: number;
  codex_recapture_ms?: number;
}

/** Expand a leading `~` to the home dir (TOML can't, so config_home may use it). */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Default codex home when config doesn't pin one: `$CODEX_HOME` or `~/.codex`. */
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

async function readToml<T>(path: string): Promise<T | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  return parse(await file.text()) as T;
}

export async function loadConfig(): Promise<Config> {
  const cfgDir = configDir();
  const raw = (await readToml<RawConfig>(join(cfgDir, "config.toml"))) ?? {};
  const data = raw.data_dir ? resolve(raw.data_dir) : dataDir();
  return {
    configDir: cfgDir,
    dataDir: data,
    vaultPath: raw.vault_path ? resolve(raw.vault_path) : join(data, "vault"),
    queueDir: join(data, "queue"),
    indexDbPath: join(data, "index.db"),
    codexBin: raw.codex_bin ?? process.env.WREN_CODEX_BIN ?? "codex",
    codexHome: raw.codex_home ? resolve(expandTilde(raw.codex_home)) : defaultCodexHome(),
    extractorModel: raw.extractor_model ?? process.env.WREN_EXTRACTOR_MODEL,
    maxInject: raw.max_inject ?? 15,
    settleMs: raw.settle_ms ?? Number(process.env.WREN_SETTLE_MS ?? 180_000),
    codexRecaptureMs:
      raw.codex_recapture_ms ?? Number(process.env.WREN_CODEX_RECAPTURE_MS ?? 3_600_000),
    fakeExtractor:
      process.env.WREN_FAKE_EXTRACTOR === "1" || process.env.WREN_FAKE_EXTRACTOR === "true",
  };
}

export function projectsPath(cfg: Config): string {
  return join(cfg.configDir, "projects.toml");
}

/**
 * Persist `codex_home` into `config.toml`, preserving the rest of the file
 * (comments included — we patch the raw text rather than re-stringify). Replaces
 * an existing `codex_home` (or its commented placeholder) line, else appends.
 * Creates the file + dir if absent. Returns the file path.
 */
export async function saveCodexHome(cfg: Config, home: string): Promise<string> {
  const path = join(cfg.configDir, "config.toml");
  await mkdir(cfg.configDir, { recursive: true });
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : "";
  const line = `codex_home = ${JSON.stringify(home)}`;
  const re = /^#?\s*codex_home\s*=.*$/m;
  const next = re.test(existing)
    ? existing.replace(re, line)
    : `${existing.trimEnd()}${existing.trim() ? "\n" : ""}${line}\n`;
  await Bun.write(path, next);
  return path;
}

export async function loadProjects(cfg: Config): Promise<ProjectRegistry> {
  const reg = await readToml<ProjectRegistry>(projectsPath(cfg));
  return reg?.projects ? reg : { projects: {} };
}

export async function saveProjects(cfg: Config, reg: ProjectRegistry): Promise<void> {
  const path = projectsPath(cfg);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, stringify(reg as unknown as Record<string, unknown>));
}

/** Normalize a path for comparison: absolute, no trailing separator. */
export function normalizePath(p: string): string {
  const r = resolve(p);
  return r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r;
}

/**
 * Return the enabled project root that owns `cwd` (exact match or ancestor),
 * or `null` if the project is not opted in. Hooks/worker call this to gate work.
 */
export function enabledScopeFor(cwd: string, reg: ProjectRegistry): string | null {
  const target = normalizePath(cwd);
  let best: string | null = null;
  for (const [path, entry] of Object.entries(reg.projects)) {
    if (!entry.enabled) continue;
    const root = normalizePath(path);
    if (target === root || target.startsWith(root + sep)) {
      if (!best || root.length > best.length) best = root; // most specific wins
    }
  }
  return best;
}

/** Create every directory the system writes to. Safe to call repeatedly. */
export async function ensureDirs(cfg: Config): Promise<void> {
  await Promise.all([
    mkdir(cfg.configDir, { recursive: true }),
    mkdir(cfg.dataDir, { recursive: true }),
    mkdir(cfg.vaultPath, { recursive: true }),
    mkdir(cfg.queueDir, { recursive: true }),
  ]);
}
