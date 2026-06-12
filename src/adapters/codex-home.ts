/**
 * Codex home detection.
 *
 * A "codex home" is the directory Codex keeps its state under — `sessions/`
 * (rollout transcripts), `config.toml`, etc. The default is `~/.codex`,
 * overridable with `$CODEX_HOME`. A machine can have more than one (a relocated
 * `$CODEX_HOME`, a leftover `~/.codex-old`, ...), so we detect them and let the
 * user pick which one wren reads transcripts from (`wren codex-home`).
 *
 * v1 detection is deliberately naive: the direct `.codex*` children of the home
 * directory, plus `$CODEX_HOME` if set. No recursive scan.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexHome {
  /** Absolute path to the codex home directory. */
  path: string;
  /** True if `$CODEX_HOME` points here. */
  fromEnv: boolean;
  /** Rollout transcripts under `<path>/sessions` (0 if none/unreadable). */
  sessions: number;
  /** mtime (ms) of the newest rollout, or null when there are none. */
  newestMs: number | null;
}

/** `<home>/sessions` — where Codex writes rollout transcripts. */
export function sessionsDir(home: string): string {
  return join(home, "sessions");
}

/**
 * Detect codex homes on this machine. Naive v1: direct `.codex*` children of the
 * home dir that are directories, plus `$CODEX_HOME` if set. Each is annotated
 * with session stats. Sorted most-recently-active first (newest rollout).
 */
export async function detectCodexHomes(): Promise<CodexHome[]> {
  const seen = new Map<string, boolean>(); // path -> fromEnv
  const env = process.env.CODEX_HOME;
  if (env) seen.set(env, true);

  let entries: string[] = [];
  try {
    entries = await readdir(homedir());
  } catch {
    /* unreadable home — fall back to env only */
  }
  for (const name of entries) {
    if (!name.startsWith(".codex")) continue;
    const path = join(homedir(), name);
    if (seen.has(path)) continue;
    try {
      if ((await stat(path)).isDirectory()) seen.set(path, false);
    } catch {
      /* vanished/unreadable — skip */
    }
  }

  const homes: CodexHome[] = [];
  for (const [path, fromEnv] of seen) {
    const { sessions, newestMs } = await codexHomeStats(path);
    homes.push({ path, fromEnv, sessions, newestMs });
  }
  homes.sort((a, b) => (b.newestMs ?? 0) - (a.newestMs ?? 0));
  return homes;
}

/** Count rollout transcripts under `<home>/sessions` and find the newest mtime. */
export async function codexHomeStats(
  home: string,
): Promise<{ sessions: number; newestMs: number | null }> {
  const root = sessionsDir(home);
  const glob = new Bun.Glob("**/rollout-*.jsonl");
  let sessions = 0;
  let newestMs: number | null = null;
  try {
    for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
      sessions++;
      try {
        const m = (await stat(join(root, rel))).mtimeMs;
        if (newestMs === null || m > newestMs) newestMs = m;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* no sessions dir under this home */
  }
  return { sessions, newestMs };
}
