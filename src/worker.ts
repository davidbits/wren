/**
 * The worker: single-instance daemon (or one-shot) that drains the durable
 * queue. For each job it parses the transcript, runs the extractor, and writes
 * memories — serialized through one process + a lock so the vault and index are
 * never written concurrently.
 */
import { stat, writeFile } from "node:fs/promises";
import { hashTranscript, parseTranscript } from "./adapters/index.ts";
import type { Config } from "./config.ts";
import { enabledScopeFor, loadProjects } from "./config.ts";
import { extract } from "./extractor/run.ts";
import {
  acquireLock,
  getDoneState,
  listPending,
  markDone,
  markFailed,
  type PendingJob,
} from "./queue/queue.ts";
import { logger } from "./util/log.ts";
import { MemoryIndex } from "./vault/index.ts";
import { readLearnings } from "./vault/store.ts";
import { writeExtraction } from "./vault/write.ts";

const log = logger("worker");
const MAX_ATTEMPTS = 3;

type Outcome = "done" | "skipped" | "retry" | "failed" | "deferred";

async function processJob(cfg: Config, index: MemoryIndex, pending: PendingJob): Promise<Outcome> {
  const { job } = pending;

  // Still opted in?
  const reg = await loadProjects(cfg);
  const scope = enabledScopeFor(job.cwd, reg);
  if (!scope) {
    log.warn("project no longer enabled; dropping", { cwd: job.cwd });
    await markDone(cfg, pending, "not-enabled");
    return "skipped";
  }

  // Transcript present?
  if (!(await Bun.file(job.transcriptPath).exists())) {
    await markFailed(cfg, pending, "transcript missing", job.attempt ?? 0);
    return "failed";
  }

  // Settled? Codex `Stop` fires per-turn with no session-end event, so we wait
  // for the transcript to go quiet (trailing debounce) before extracting — this
  // turns N per-turn fires into one end-of-session extraction. The pending file
  // is left in place; the next drain re-checks it. Claude `SessionEnd` already
  // marks a real end, so its transcript is settled by definition.
  let transcriptMtimeMs: number | undefined;
  if (job.agent === "codex") {
    const { mtimeMs } = await stat(job.transcriptPath);
    transcriptMtimeMs = mtimeMs;
    if (Date.now() - mtimeMs < cfg.settleMs) {
      log.debug("transcript still settling; deferring", { session: job.sessionId });
      return "deferred";
    }
  }

  const previous = await getDoneState(cfg, job.sessionId);
  if (job.agent === "codex" && previous?.doneAt && transcriptMtimeMs !== undefined) {
    const previousDoneMs = Date.parse(previous.doneAt);
    if (Number.isFinite(previousDoneMs)) {
      if (transcriptMtimeMs < previousDoneMs) {
        log.info("already processed; skipping", { session: job.sessionId });
        await markDone(cfg, pending, previous.hash ?? "already-done");
        return "skipped";
      }
      if (Date.now() - previousDoneMs < cfg.codexRecaptureMs) {
        log.debug("codex revision throttled; deferring", { session: job.sessionId });
        return "deferred";
      }
    }
  }

  const hash = await hashTranscript(job.transcriptPath);
  if (previous?.hash === hash) {
    log.info("already processed; skipping", { session: job.sessionId });
    await markDone(cfg, pending, hash);
    return "skipped";
  }

  try {
    const transcript = await parseTranscript(job.agent, job.transcriptPath);
    transcript.cwd ||= job.cwd;
    transcript.sessionId ||= job.sessionId;

    const existing = await readLearnings(cfg, ["global", scope]);
    const result = await extract(cfg, transcript, scope, existing);

    if (!result.durable) {
      log.info("nothing durable; no write", { session: job.sessionId });
      await markDone(cfg, pending, hash);
      return "skipped";
    }

    const summary = await writeExtraction(cfg, index, {
      result,
      agent: job.agent,
      sessionId: job.sessionId,
      scope,
      nowIso: new Date().toISOString(),
    });
    log.info("wrote memories", {
      session: job.sessionId,
      revision: !!previous?.hash,
      learnings: summary.learningPaths.length,
      session_note: !!summary.sessionNotePath,
    });
    await markDone(cfg, pending, hash);
    return "done";
  } catch (err) {
    const attempt = (job.attempt ?? 0) + 1;
    const msg = err instanceof Error ? err.message : String(err);
    if (attempt >= MAX_ATTEMPTS) {
      log.error("job failed permanently", { session: job.sessionId, attempt, msg });
      await markFailed(cfg, pending, msg, attempt);
      return "failed";
    }
    log.warn("job failed; will retry", { session: job.sessionId, attempt, msg });
    await writeFile(pending.path, JSON.stringify({ ...job, attempt }, null, 2));
    return "retry";
  }
}

export interface DrainStats {
  done: number;
  skipped: number;
  failed: number;
  retry: number;
  deferred: number;
}

/** Process every currently-pending job once. Caller holds the lock. */
async function drain(cfg: Config, index: MemoryIndex): Promise<DrainStats> {
  const stats: DrainStats = { done: 0, skipped: 0, failed: 0, retry: 0, deferred: 0 };
  const pending = await listPending(cfg);
  for (const job of pending) {
    const outcome = await processJob(cfg, index, job);
    stats[outcome]++;
  }
  return stats;
}

/** One-shot drain (used by `worker --once` and tests). */
export async function runOnce(cfg: Config): Promise<DrainStats> {
  const release = await acquireLock(cfg);
  if (!release) {
    log.warn("another worker holds the lock; exiting");
    return { done: 0, skipped: 0, failed: 0, retry: 0, deferred: 0 };
  }
  const index = await MemoryIndex.open(cfg.indexDbPath);
  try {
    const stats = await drain(cfg, index);
    log.info("drain complete", stats);
    return stats;
  } finally {
    index.close();
    await release();
  }
}

/** Long-running daemon: drain, sleep, repeat until SIGINT/SIGTERM. */
export async function runDaemon(cfg: Config, intervalMs = 5000): Promise<void> {
  const release = await acquireLock(cfg);
  if (!release) {
    log.error("another worker is already running; exiting");
    return;
  }
  const index = await MemoryIndex.open(cfg.indexDbPath);
  let running = true;
  const stop = async () => {
    if (!running) return;
    running = false;
    log.info("shutting down");
    index.close();
    await release();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  log.info("worker daemon started", { intervalMs, vault: cfg.vaultPath });
  while (running) {
    try {
      const stats = await drain(cfg, index);
      if (stats.done || stats.failed) log.info("drain", stats);
    } catch (err) {
      log.error("drain error", { err: String(err) });
    }
    await Bun.sleep(intervalMs);
  }
}
