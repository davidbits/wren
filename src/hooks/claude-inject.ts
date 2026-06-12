#!/usr/bin/env bun
/**
 * Claude Code SessionStart inject hook.
 *
 * If the project is opted in, emits a compact, capped list of the most relevant
 * learnings for this cwd (project scope + global) as `additionalContext`, which
 * Claude folds into the session. This is the cheap, always-on half of retrieval;
 * the MCP server is the pull-based deep-recall half.
 *
 * Wire it up in `.claude/settings.local.json`:
 *   "hooks": { "SessionStart": [{ "hooks": [{ "type": "command",
 *     "command": "bun run <repo>/src/hooks/claude-inject.ts" }] }] }
 */
import { enabledScopeFor, loadConfig, loadProjects } from "../config.ts";
import { logger } from "../util/log.ts";
import { MemoryIndex, type SearchHit } from "../vault/index.ts";
import { scopesFor } from "../vault/store.ts";
import { type ClaudeHookInput, readHookInput } from "./stdin.ts";

const log = logger("claude-inject");

function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/\s+/g, " ").slice(0, 240);
}

function format(hits: SearchHit[]): string {
  const lines = hits.map((h) => {
    const tag = h.scope === "global" ? "global" : h.type;
    return `- **${h.title}** _(${tag})_ — ${firstLine(h.body)}`;
  });
  return [
    "# Agent Memory — recalled for this project",
    "Durable learnings from past sessions here. Apply them; use the `wren` MCP `search_memories` tool for deeper recall.",
    "",
    ...lines,
  ].join("\n");
}

export async function runClaudeInject(): Promise<void> {
  const input = await readHookInput<ClaudeHookInput>();
  const cwd = input.cwd ?? process.cwd();

  const cfg = await loadConfig();
  const reg = await loadProjects(cfg);
  const scope = enabledScopeFor(cwd, reg);
  if (!scope) return; // not opted in → inject nothing

  const index = await MemoryIndex.open(cfg.indexDbPath);
  try {
    const scopes = scopesFor(scope);
    const recent = index.recent({ scopes, limit: cfg.maxInject * 3 });
    const learnings = recent.filter((h) => h.type !== "session").slice(0, cfg.maxInject);
    if (!learnings.length) return;

    const output = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: format(learnings),
      },
    };
    process.stdout.write(JSON.stringify(output));
    log.debug("injected memories", { count: learnings.length });
  } finally {
    index.close();
  }
}

if (import.meta.main) {
  runClaudeInject()
    .catch((err) => {
      log.error("inject failed", { err: String(err) });
    })
    .finally(() => process.exit(0));
}
