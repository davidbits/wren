#!/usr/bin/env bun
import { hashTranscript, parseTranscript } from "./adapters/index.ts";
import { runCodexHome } from "./commands/codex-home.ts";
import { consolidate } from "./commands/consolidate.ts";
import { deleteById } from "./commands/delete.ts";
import { disableProject, enableProject } from "./commands/enable.ts";
import { install } from "./commands/install.ts";
import { status } from "./commands/status.ts";
/**
 * wren CLI — single entrypoint, multiple subcommands.
 *
 *   install     wire MCP + worker into detected agents
 *   enable      opt a project in (registry + agent hooks)
 *   disable     opt a project out
 *   worker      drain the queue (daemon, or --once)
 *   mcp         run the stdio MCP server
 *   rebuild     rebuild the search index from the vault
 *   consolidate prune/supersede near-duplicate learnings
 *   delete      delete one memory or session note by id
 *   status      show config, projects, queue, index
 *   extract     manually extract one transcript (testing/backfill)
 *   hook        run an agent hook by name (internal: invoked by wiring)
 */
import { enabledScopeFor, loadConfig, loadProjects, normalizePath } from "./config.ts";
import { extract } from "./extractor/run.ts";
import { runClaudeCapture } from "./hooks/claude-capture.ts";
import { runClaudeInject } from "./hooks/claude-inject.ts";
import { runCodexCapture } from "./hooks/codex-capture.ts";
import { runMcpServer } from "./mcp/server.ts";
import type { Agent } from "./types.ts";
import { logger } from "./util/log.ts";
import { MemoryIndex } from "./vault/index.ts";
import { rebuildIndex } from "./vault/rebuild.ts";
import { readLearnings } from "./vault/store.ts";
import { writeExtraction } from "./vault/write.ts";
import { runDaemon, runOnce } from "./worker.ts";

const log = logger("cli");

const HELP = `wren — async memory capture for AI coding agents

Usage: wren <command> [options]

Commands:
  install [--codex] [--systemd]   Set up config, MCP registration, worker unit
  enable <path> [--codex]         Opt in; --codex trusts all detected homes
  disable <path>                  Opt a project out
  worker [--once] [--interval N]  Drain the queue (daemon by default)
  mcp                             Run the stdio MCP server
  rebuild                         Rebuild the search index from the vault
  consolidate [--dry-run]         Prune/supersede near-duplicate learnings
  delete <memory|session> <id>    Delete one memory or session note
  codex-home                      Detect codex homes; pick which one to extract from
  status                          Show config, projects, queue, index
  extract <file> [--agent A] [--cwd P] [--scope S]
                                  Manually extract one transcript
  hook <name>                     Run an agent hook (internal: used by wiring)
`;

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

const VALUE_FLAGS = new Set(["--agent", "--cwd", "--scope", "--interval"]);

/** Positional args, skipping flags and the values that follow value-flags. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

async function runExtract(args: string[]): Promise<void> {
  const cfg = await loadConfig();
  const transcriptPath = positionals(args)[0];
  if (!transcriptPath) {
    console.error("extract: missing transcript path");
    process.exit(1);
  }
  const agent = (flagValue(args, "--agent") ?? "claude-code") as Agent;
  const cwd = flagValue(args, "--cwd");

  const transcript = await parseTranscript(agent, transcriptPath);
  const effectiveCwd = cwd ?? transcript.cwd ?? process.cwd();
  const reg = await loadProjects(cfg);
  const scope =
    flagValue(args, "--scope") ?? enabledScopeFor(effectiveCwd, reg) ?? normalizePath(effectiveCwd);

  const existing = await readLearnings(cfg, ["global", scope]);
  const result = await extract(cfg, transcript, scope, existing);
  if (!result.durable) {
    console.log("Nothing durable — no memories written.");
    return;
  }
  const index = await MemoryIndex.open(cfg.indexDbPath);
  try {
    const summary = await writeExtraction(cfg, index, {
      result,
      agent,
      sessionId:
        transcript.sessionId || `manual-${await hashTranscript(transcriptPath)}`.slice(0, 24),
      scope,
      nowIso: new Date().toISOString(),
    });
    console.log(
      `Wrote ${summary.learningPaths.length} learning(s)${summary.sessionNotePath ? " + session note" : ""}.`,
    );
    for (const p of summary.learningPaths) console.log(`  • ${p}`);
  } finally {
    index.close();
  }
}

/**
 * Run an agent hook by name. Hooks read their own stdin payload and must never
 * fail the calling agent, so a thrown error is logged and swallowed (exit 0).
 */
async function runHook(name: string | undefined): Promise<void> {
  try {
    switch (name) {
      case "claude-capture":
        await runClaudeCapture();
        break;
      case "claude-inject":
        await runClaudeInject();
        break;
      case "codex-capture":
        await runCodexCapture();
        break;
      default:
        fail(`hook: unknown hook "${name ?? ""}"`);
    }
  } catch (err) {
    log.error("hook failed", { name, err: err instanceof Error ? err.stack : String(err) });
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const cfg = await loadConfig();

  switch (command) {
    case "install":
      await install(cfg, { codex: hasFlag(args, "--codex"), systemd: hasFlag(args, "--systemd") });
      break;
    case "enable": {
      const path = args.find((a) => !a.startsWith("--"));
      if (!path) return fail("enable: missing <path>");
      await enableProject(cfg, path, { codex: hasFlag(args, "--codex") });
      break;
    }
    case "disable": {
      const path = args.find((a) => !a.startsWith("--"));
      if (!path) return fail("disable: missing <path>");
      await disableProject(cfg, path);
      break;
    }
    case "worker":
      if (hasFlag(args, "--once")) {
        await runOnce(cfg);
      } else {
        await runDaemon(cfg, Number(flagValue(args, "--interval") ?? 5000));
      }
      break;
    case "mcp":
      await runMcpServer();
      break;
    case "hook":
      await runHook(args[0]);
      break;
    case "rebuild": {
      const n = await rebuildIndex(cfg);
      console.log(`Rebuilt index: ${n} memories.`);
      break;
    }
    case "consolidate": {
      const stats = await consolidate(cfg, { dryRun: hasFlag(args, "--dry-run") });
      console.log(
        `Consolidation: ${stats.clusters} cluster(s), ${stats.pruned} pruned${stats.dryRun ? " (dry run)" : ""}.`,
      );
      break;
    }
    case "delete": {
      const [target, id] = positionals(args);
      if (target !== "memory" && target !== "session") {
        return fail("delete: expected <memory|session> <id>");
      }
      if (!id) return fail(`delete ${target}: missing <id>`);
      await deleteById(cfg, target, id);
      break;
    }
    case "codex-home":
      await runCodexHome(cfg);
      break;
    case "status":
      await status(cfg);
      break;
    case "extract":
      await runExtract(args);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      break;
    case "--version":
    case "version":
      console.log("wren 0.1.0");
      break;
    default:
      fail(`unknown command: ${command}\n\n${HELP}`);
  }
}

function fail(msg: string): void {
  console.error(msg);
  process.exit(1);
}

main().catch((err) => {
  log.error("fatal", { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
