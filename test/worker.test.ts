import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Config, saveProjects } from "../src/config.ts";
import { enqueue, listPending } from "../src/queue/queue.ts";
import type { Job } from "../src/types.ts";
import { runOnce } from "../src/worker.ts";
import { cleanup, makeTmpConfig } from "./helpers.ts";

/** A minimal valid Codex rollout: session_meta first, then real turns. */
function codexRollout(cwd: string): string {
  return [
    { type: "session_meta", timestamp: "2026-06-12T10:00:00Z", payload: { id: "sess-1", cwd } },
    {
      type: "response_item",
      timestamp: "2026-06-12T10:00:01Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "fix the queue bug" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-06-12T10:00:02Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "fixed it with an atomic rename" }],
      },
    },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");
}

/** A minimal valid Claude transcript with real turns. */
function claudeTranscript(cwd: string): string {
  return [
    {
      type: "user",
      sessionId: "csess-1",
      cwd,
      timestamp: "2026-06-12T10:00:00Z",
      message: { role: "user", content: "fix the queue bug" },
    },
    {
      type: "assistant",
      sessionId: "csess-1",
      cwd,
      timestamp: "2026-06-12T10:00:01Z",
      message: { role: "assistant", content: "fixed it with an atomic rename" },
    },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");
}

describe("worker settle window", () => {
  let cfg: Config;
  let project: string;

  beforeEach(async () => {
    cfg = makeTmpConfig();
    cfg.settleMs = 60_000; // generous window so a freshly-written file is always "settling"
    project = join(cfg.dataDir, "proj");
    await mkdir(project, { recursive: true });
    await saveProjects(cfg, { projects: { [project]: { enabled: true, added: "2026-06-12" } } });
  });
  afterEach(async () => {
    await cleanup(cfg);
  });

  async function writeTranscript(name: string, body: string, ageMs = 0): Promise<string> {
    const path = join(cfg.dataDir, name);
    await writeFile(path, body);
    if (ageMs > 0) {
      const past = new Date(Date.now() - ageMs);
      await utimes(path, past, past);
    }
    return path;
  }

  function job(agent: Job["agent"], transcriptPath: string, sessionId: string): Job {
    return { agent, transcriptPath, cwd: project, sessionId, enqueuedAt: "2026-06-12T10:00:03Z" };
  }

  it("defers a freshly-written Codex transcript and leaves it pending", async () => {
    const path = await writeTranscript("fresh.jsonl", codexRollout(project));
    await enqueue(cfg, job("codex", path, "sess-fresh"));

    const stats = await runOnce(cfg);
    expect(stats.deferred).toBe(1);
    expect(stats.done).toBe(0);
    expect((await listPending(cfg)).length).toBe(1);
  });

  it("processes a settled (old-mtime) Codex transcript", async () => {
    const path = await writeTranscript("stale.jsonl", codexRollout(project), 120_000);
    await enqueue(cfg, job("codex", path, "sess-stale"));

    const stats = await runOnce(cfg);
    expect(stats.deferred).toBe(0);
    expect(stats.done).toBe(1);
    expect((await listPending(cfg)).length).toBe(0);
    const done = await Bun.file(join(cfg.queueDir, "done", "sess-stale.json")).json();
    expect(done.extractor).toEqual({
      engine: "fake",
      binary: "codex",
      codex_home: cfg.codexHome,
      transcript_home: cfg.codexHome,
      model: "local-heuristic",
    });
  });

  it("throttles a changed Codex session after an earlier extraction", async () => {
    cfg.settleMs = 0;
    cfg.codexRecaptureMs = 60_000;
    const path = await writeTranscript("revision.jsonl", codexRollout(project), 120_000);
    await enqueue(cfg, job("codex", path, "sess-revision"));
    expect((await runOnce(cfg)).done).toBe(1);

    await writeFile(path, `${codexRollout(project)}\n`);
    await enqueue(cfg, job("codex", path, "sess-revision"));
    const stats = await runOnce(cfg);

    expect(stats.deferred).toBe(1);
    expect(stats.done).toBe(0);
    expect((await listPending(cfg)).length).toBe(1);
  });

  it("never defers a Claude job, even with a fresh transcript", async () => {
    const path = await writeTranscript("claude.jsonl", claudeTranscript(project));
    await enqueue(cfg, job("claude-code", path, "sess-claude"));

    const stats = await runOnce(cfg);
    expect(stats.deferred).toBe(0);
    expect(stats.done).toBe(1);
    expect((await listPending(cfg)).length).toBe(0);
  });
});
