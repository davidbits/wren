/**
 * Shared helpers for wiring wren into agents (install/enable).
 *
 * Every command we write into an agent config (Claude/Codex hooks, MCP
 * registration, the systemd unit) must re-invoke wren. Which invocation
 * that is depends on how we're running:
 *   - compiled standalone binary → re-invoke the binary itself (`wren …`)
 *   - dev (`bun run src/cli.ts`)  → `bun run <repo>/src/cli.ts …`
 * `selfCommand()` papers over the difference so callers never hardcode either,
 * which is what makes the installed binary work with no source tree present.
 */
import { basename, join, resolve } from "node:path";

/** Repo root (two levels up from src/commands/). Meaningful in dev mode only. */
export function repoRoot(): string {
  return resolve(join(import.meta.dir, "..", ".."));
}

/** The binary running us — the wren binary when compiled, else `bun`. */
export function bunBin(): string {
  return process.execPath;
}

export function scriptPath(rel: string): string {
  return join(repoRoot(), rel);
}

/**
 * True when running as a `bun build --compile` standalone binary. Such binaries
 * execute embedded code from Bun's virtual filesystem, so module paths live
 * under a synthetic root (`/$bunfs/…` posix, `B:\~BUN\…` Windows) that does not
 * exist for `bun run`. We also fall back to the exec basename: a standalone
 * binary's execPath is the binary itself, never `bun`.
 */
export function isCompiled(): boolean {
  const dir = import.meta.dir;
  if (dir.startsWith("/$bunfs") || dir.includes("/~BUN/") || dir.startsWith("B:\\~BUN")) {
    return true;
  }
  const exe = basename(process.execPath);
  return exe !== "bun" && exe !== "bun-debug";
}

/**
 * argv that re-invokes this program. Compiled: just the binary. Dev: bun + the
 * CLI entry script. Append the subcommand + args to either.
 */
export function selfCommand(): string[] {
  return isCompiled() ? [bunBin()] : [bunBin(), "run", scriptPath(CLI)];
}

/** Shell command string that re-invokes wren with the given args. */
export function selfCommandString(...args: string[]): string {
  return [...selfCommand(), ...args].join(" ");
}

// Hook subcommand names (`wren hook <name>`), shared by the wiring and
// the cli.ts dispatcher.
export const CLAUDE_CAPTURE = "claude-capture";
export const CLAUDE_INJECT = "claude-inject";
export const CODEX_CAPTURE = "codex-capture";
export const CLI = "src/cli.ts";
