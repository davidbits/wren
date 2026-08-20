import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Config, saveProjects } from "../src/config.ts";
import { listPending } from "../src/queue/queue.ts";
import { runOnce } from "../src/worker.ts";
import { cleanup, makeTmpConfig } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function runHook(cfg: Config, payload: unknown): Promise<void> {
  const proc = Bun.spawn(["bun", "run", CLI, "hook", "claude-capture"], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: {
      ...process.env,
      WREN_CONFIG_DIR: cfg.configDir,
      WREN_DATA_DIR: cfg.dataDir,
      WREN_FAKE_EXTRACTOR: "1",
      WREN_NO_AUTODRAIN: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

describe("claude-capture transcript staging", () => {
  let cfg: Config;
  let project: string;

  beforeEach(async () => {
    cfg = makeTmpConfig();
    project = join(cfg.dataDir, "proj");
    await mkdir(project, { recursive: true });
    await saveProjects(cfg, { projects: { [project]: { enabled: true, added: "2026-06-12" } } });
  });
  afterEach(async () => {
    await cleanup(cfg);
  });

  it("copies the transcript and records hook metadata", async () => {
    const source = join(project, "session.jsonl");
    const body = [
      {
        type: "user",
        sessionId: "claude-session",
        cwd: project,
        message: { role: "user", content: "fix the queue bug" },
      },
      {
        type: "assistant",
        sessionId: "claude-session",
        cwd: project,
        message: { role: "assistant", content: "fixed it with an atomic rename" },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    await writeFile(source, body);
    await runHook(cfg, {
      hook_event_name: "SessionEnd",
      session_id: "claude-session",
      transcript_path: source,
      cwd: project,
      reason: "other",
      agent_type: "reviewer",
    });

    const pending = await listPending(cfg);
    expect(pending.length).toBe(1);
    expect(pending[0]?.job.transcriptPath).not.toBe(source);
    expect(pending[0]?.job.sourceTranscriptPath).toBe(source);
    expect(pending[0]?.job.transcriptOwned).toBe(true);
    expect(pending[0]?.job.reason).toBe("other");
    expect(pending[0]?.job.agentType).toBe("reviewer");
    const staged = pending[0]!.job.transcriptPath;
    expect(await Bun.file(staged).text()).toBe(body);

    await rm(source);
    expect((await runOnce(cfg)).done).toBe(1);
    expect(await Bun.file(staged).exists()).toBe(false);
  });
});
