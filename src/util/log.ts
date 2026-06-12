/**
 * Tiny structured logger. Writes to stderr so it never pollutes hook stdout
 * (Claude parses hook stdout as JSON) or the MCP stdio channel.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = (() => {
  const env = (process.env.WREN_LOG_LEVEL ?? "info").toLowerCase();
  return env in LEVELS ? LEVELS[env as Level] : LEVELS.info;
})();

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) {
    line += ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  }
  process.stderr.write(`${line}\n`);
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit("debug", scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit("info", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit("error", scope, msg, extra),
  };
}
