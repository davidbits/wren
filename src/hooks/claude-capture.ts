#!/usr/bin/env bun
/**
 * Claude Code SessionEnd capture hook.
 *
 * Reads the hook payload from stdin, and if the project is opted in, enqueues a
 * job pointing at the transcript. Does ZERO LLM work and never blocks the agent:
 * it enqueues, optionally nudges a one-shot worker (no-op if a daemon already
 * holds the lock), and always exits 0.
 *
 * Wire it up (per project, gitignored) in `.claude/settings.local.json`:
 *   "hooks": { "SessionEnd": [{ "hooks": [{ "type": "command",
 *     "command": "bun run <repo>/src/hooks/claude-capture.ts", "async": true }] }] }
 */
import { selfCommand } from "../commands/integration.ts";
import { enabledScopeFor, loadConfig, loadProjects } from "../config.ts";
import { enqueue, stageTranscript } from "../queue/queue.ts";
import type { Job } from "../types.ts";
import { logger } from "../util/log.ts";
import { type ClaudeHookInput, readHookInput } from "./stdin.ts";

const log = logger("claude-capture");

export async function runClaudeCapture(): Promise<void> {
  const input = await readHookInput<ClaudeHookInput>();
  const cwd = input.cwd ?? process.cwd();
  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId || !transcriptPath) {
    log.debug("missing session_id/transcript_path; no-op");
    return;
  }

  const cfg = await loadConfig();
  const reg = await loadProjects(cfg);
  if (!enabledScopeFor(cwd, reg)) {
    log.debug("project not opted in; no-op", { cwd });
    return;
  }

  let queuedTranscriptPath = transcriptPath;
  let transcriptOwned = false;
  try {
    queuedTranscriptPath = await stageTranscript(cfg, sessionId, transcriptPath);
    transcriptOwned = true;
  } catch (err) {
    log.warn("could not stage transcript; queueing agent path", {
      session: sessionId,
      err: String(err),
    });
  }

  const job: Job = {
    agent: "claude-code",
    transcriptPath: queuedTranscriptPath,
    sourceTranscriptPath: transcriptOwned ? transcriptPath : undefined,
    transcriptOwned,
    cwd,
    sessionId,
    enqueuedAt: new Date().toISOString(),
    reason: input.reason,
    agentType: input.agent_type,
  };
  await enqueue(cfg, job);

  // Fallback drain so the system works even without the systemd daemon. The
  // worker lock guarantees only one actually runs; the rest exit immediately.
  if (process.env.WREN_NO_AUTODRAIN !== "1") {
    try {
      Bun.spawn([...selfCommand(), "worker", "--once"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).unref();
    } catch (err) {
      log.debug("autodrain spawn failed (daemon will handle it)", { err: String(err) });
    }
  }
}

// Standalone invocation (`bun run src/hooks/claude-capture.ts`) for dev/back-compat.
// When imported by the compiled binary's cli dispatcher, import.meta.main is
// false and this is skipped — the dispatcher calls runClaudeCapture() directly.
if (import.meta.main) {
  runClaudeCapture()
    .catch((err) => log.error("capture failed", { err: String(err) }))
    .finally(() => process.exit(0));
}
