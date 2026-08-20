/**
 * Durable file-per-job queue.
 *
 * Each job is a single JSON file under `queue/pending/<sessionId>.json`. Writes
 * are atomic (temp file + rename) so a crash mid-write never leaves a partial
 * job. Using the session id as the filename naturally debounces the per-turn
 * Stop hooks (Codex/Claude `Stop` fire every turn) — re-enqueuing the same
 * session just overwrites the pending job with the latest transcript path.
 *
 * The worker moves jobs pending → done (or → failed) with `rename`, which is
 * atomic on POSIX, so concurrent or crashed workers can't corrupt state.
 */
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { Job } from "../types.ts";
import { logger } from "../util/log.ts";

const log = logger("queue");

function dirs(cfg: Config) {
  return {
    pending: join(cfg.queueDir, "pending"),
    done: join(cfg.queueDir, "done"),
    failed: join(cfg.queueDir, "failed"),
    transcripts: join(cfg.queueDir, "transcripts"),
    lock: join(cfg.queueDir, "worker.lock"),
  };
}

function safeName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function ensure(cfg: Config): Promise<void> {
  const d = dirs(cfg);
  await Promise.all([
    mkdir(d.pending, { recursive: true }),
    mkdir(d.done, { recursive: true }),
    mkdir(d.failed, { recursive: true }),
    mkdir(d.transcripts, { recursive: true }),
  ]);
}

/** Copy an agent-owned transcript into Wren storage before the agent can remove it. */
export async function stageTranscript(
  cfg: Config,
  sessionId: string,
  sourcePath: string,
): Promise<string> {
  await ensure(cfg);
  const d = dirs(cfg);
  const dest = join(d.transcripts, `${safeName(sessionId)}-${randomUUID()}.jsonl`);
  const tmp = `${dest}.tmp`;
  try {
    await copyFile(sourcePath, tmp);
    await chmod(tmp, 0o600);
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return dest;
}

/** Append (or refresh) a job. Atomic; safe to call from the fire-and-forget hook. */
export async function enqueue(cfg: Config, job: Job): Promise<void> {
  await ensure(cfg);
  const d = dirs(cfg);
  const dest = join(d.pending, `${safeName(job.sessionId)}.json`);
  const tmp = `${dest}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(job, null, 2));
  await rename(tmp, dest);
  log.info("enqueued", { session: job.sessionId, agent: job.agent });
}

export interface PendingJob {
  job: Job;
  path: string;
}

/** All pending jobs, oldest first. */
export async function listPending(cfg: Config): Promise<PendingJob[]> {
  await ensure(cfg);
  const d = dirs(cfg);
  const names = (await readdir(d.pending)).filter((n) => n.endsWith(".json"));
  const out: PendingJob[] = [];
  for (const name of names) {
    const path = join(d.pending, name);
    try {
      const job = (await Bun.file(path).json()) as Job;
      out.push({ job, path });
    } catch (err) {
      log.warn("skipping unreadable job", { path, err: String(err) });
    }
  }
  out.sort((a, b) => a.job.enqueuedAt.localeCompare(b.job.enqueuedAt));
  return out;
}

/** True if this exact session+transcript was already processed successfully. */
export interface DoneState {
  hash?: string;
  doneAt?: string;
}

export async function getDoneState(cfg: Config, sessionId: string): Promise<DoneState | null> {
  const marker = join(dirs(cfg).done, `${safeName(sessionId)}.json`);
  const file = Bun.file(marker);
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as DoneState;
  } catch {
    return null;
  }
}

/** True if this exact session+transcript was already processed successfully. */
export async function alreadyDone(cfg: Config, sessionId: string, hash: string): Promise<boolean> {
  return (await getDoneState(cfg, sessionId))?.hash === hash;
}

async function removePendingIfCurrent(pending: PendingJob): Promise<void> {
  try {
    const current = (await Bun.file(pending.path).json()) as Job;
    if (
      current.enqueuedAt !== pending.job.enqueuedAt ||
      current.transcriptPath !== pending.job.transcriptPath
    ) {
      return;
    }
  } catch {
    return;
  }
  await rm(pending.path, { force: true });
}

/** Move a job from pending to done, recording the transcript hash for idempotency. */
export async function markDone(cfg: Config, pending: PendingJob, hash: string): Promise<void> {
  const d = dirs(cfg);
  const marker = join(d.done, `${safeName(pending.job.sessionId)}.json`);
  await writeFile(
    marker,
    JSON.stringify({ ...pending.job, hash, doneAt: new Date().toISOString() }, null, 2),
  );
  await removePendingIfCurrent(pending);
  if (pending.job.transcriptOwned) {
    await rm(pending.job.transcriptPath, { force: true });
  }
}

/** Move a job to failed/ with the error and attempt count. */
export async function markFailed(
  cfg: Config,
  pending: PendingJob,
  error: string,
  attempt: number,
): Promise<void> {
  const d = dirs(cfg);
  const dest = join(d.failed, `${safeName(pending.job.sessionId)}.json`);
  await writeFile(
    dest,
    JSON.stringify({ ...pending.job, error, attempt, failedAt: new Date().toISOString() }, null, 2),
  );
  await removePendingIfCurrent(pending);
}

/**
 * Acquire a single-worker lock. Returns a release function, or `null` if another
 * live worker holds it. A lock whose pid is no longer alive is treated as stale
 * and stolen.
 */
export async function acquireLock(cfg: Config): Promise<(() => Promise<void>) | null> {
  await mkdir(cfg.queueDir, { recursive: true });
  const lockPath = dirs(cfg).lock;
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });

  const tryCreate = async (): Promise<boolean> => {
    try {
      // wx = fail if exists.
      await writeFile(lockPath, payload, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };

  if (await tryCreate()) return makeRelease(lockPath);

  // Lock exists — check liveness.
  try {
    const { pid } = (await Bun.file(lockPath).json()) as { pid: number };
    if (pid && isAlive(pid)) {
      log.warn("worker lock held by live pid", { pid });
      return null;
    }
    log.warn("stealing stale worker lock", { pid });
    await rm(lockPath, { force: true });
    if (await tryCreate()) return makeRelease(lockPath);
  } catch {
    // Corrupt lock file — remove and retry once.
    await rm(lockPath, { force: true });
    if (await tryCreate()) return makeRelease(lockPath);
  }
  return null;
}

function makeRelease(lockPath: string): () => Promise<void> {
  return async () => {
    await rm(lockPath, { force: true });
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
