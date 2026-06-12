#!/usr/bin/env bun
/**
 * Codex Stop capture hook.
 *
 * Validates the documented Codex hooks wire format (developers.openai.com/codex/
 * hooks): every hook receives `session_id`, `cwd`, `hook_event_name`, and a
 * nullable `transcript_path` pointing at the rollout `.jsonl`. We use that path
 * directly. Only when Codex hands us a null `transcript_path` do we fall back to
 * discovering the newest rollout for this cwd.
 *
 * `Stop` fires per-turn (Codex has no session-end event); the worker's settle
 * window debounces those into one end-of-session extraction, and the queue
 * dedups by session id, so per-turn firing is harmless.
 */
import { z } from "zod";
import { findLatestCodexRollout } from "../adapters/codex.ts";
import { enabledScopeFor, loadConfig, loadProjects } from "../config.ts";
import { enqueue } from "../queue/queue.ts";
import type { Job } from "../types.ts";
import { logger } from "../util/log.ts";
import { readHookInput } from "./stdin.ts";

const log = logger("codex-capture");

/** Documented Codex Stop payload (common fields + Stop-specific; extras tolerated). */
const CodexStop = z
  .object({
    hook_event_name: z.string().optional(),
    session_id: z.string().optional(),
    transcript_path: z.string().nullish(),
    cwd: z.string().optional(),
  })
  .passthrough();

export async function runCodexCapture(): Promise<void> {
  const raw = await readHookInput<unknown>();
  const input = CodexStop.parse(raw);
  const cwd = input.cwd ?? process.cwd();

  const cfg = await loadConfig();
  const reg = await loadProjects(cfg);
  if (!enabledScopeFor(cwd, reg)) {
    log.debug("project not opted in; no-op", { cwd });
    return;
  }

  let transcriptPath = input.transcript_path ?? undefined;
  let sessionId = input.session_id ?? "";
  if (!transcriptPath) {
    // Documented field was null/absent — last-resort discovery by cwd.
    log.warn("stop payload had no transcript_path; discovering rollout by cwd", { cwd });
    const found = await findLatestCodexRollout(cwd);
    if (!found) {
      log.warn("no codex rollout found for cwd; no-op", { cwd });
      return;
    }
    transcriptPath = found.path;
    sessionId ||= found.sessionId;
  }
  if (!sessionId) sessionId = `codex-${transcriptPath}`;

  const job: Job = {
    agent: "codex",
    transcriptPath,
    cwd,
    sessionId,
    enqueuedAt: new Date().toISOString(),
  };
  await enqueue(cfg, job);
  log.info("codex session enqueued", { session: sessionId });
}

if (import.meta.main) {
  runCodexCapture()
    .catch((err) => log.error("codex capture failed", { err: String(err) }))
    .finally(() => process.exit(0));
}
