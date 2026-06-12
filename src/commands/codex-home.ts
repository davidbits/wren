/**
 * `wren codex-home` — detect the codex homes on this machine and let the user
 * pick which one wren reads transcripts from. The choice is persisted as
 * `codex_home` in `config.toml`; the capture hook + worker then resolve rollouts
 * under `<codex_home>/sessions`.
 *
 * Interactive: prompts only when more than one home is found. A single home is
 * selected automatically. In a non-TTY (piped) run, `prompt()` returns null and
 * we fall back to the default — the most-recently-active home (homes are sorted
 * newest-first).
 */
import { homedir } from "node:os";
import type { CodexHome } from "../adapters/codex-home.ts";
import { detectCodexHomes } from "../adapters/codex-home.ts";
import { type Config, saveCodexHome } from "../config.ts";
import { logger } from "../util/log.ts";

const log = logger("codex-home");

/** `~/x` form for display + storage (config expands `~` on read). */
function tildeify(p: string): string {
  const h = homedir();
  if (p === h) return "~";
  return p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

/** Coarse "time since" for the newest rollout. */
function ago(ms: number | null): string {
  if (ms === null) return "no sessions";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function describe(h: CodexHome): string {
  const tag = h.fromEnv ? "  [$CODEX_HOME]" : "";
  const stats = h.sessions
    ? `${h.sessions} session${h.sessions === 1 ? "" : "s"}, newest ${ago(h.newestMs)}`
    : "no sessions";
  return `${tildeify(h.path)}${tag}  (${stats})`;
}

export async function runCodexHome(cfg: Config): Promise<void> {
  const homes = await detectCodexHomes();
  if (homes.length === 0) {
    console.log("No codex homes found (looked for ~/.codex* and $CODEX_HOME).");
    console.log('Set one explicitly with  codex_home = "..."  in config.toml.');
    return;
  }

  console.log("Detected codex homes:");
  homes.forEach((h, i) => {
    console.log(`  ${i + 1}) ${describe(h)}`);
  });

  let choice = 0; // default: first = most-recently-active
  if (homes.length === 1) {
    console.log(`\nOnly one — selecting ${tildeify(homes[0]!.path)}.`);
  } else {
    const ans = prompt(`\nUse which? [1-${homes.length}, default 1]:`)?.trim();
    if (ans) {
      const n = Number(ans);
      if (!Number.isInteger(n) || n < 1 || n > homes.length) {
        console.error(`Invalid selection: ${ans}`);
        process.exit(1);
      }
      choice = n - 1;
    }
  }

  const selected = homes[choice]!;
  const stored = tildeify(selected.path);
  const path = await saveCodexHome(cfg, stored);
  console.log(`\n✓ wrote codex_home = ${JSON.stringify(stored)} → ${path}`);
  log.info("codex home selected", { home: selected.path });
}
