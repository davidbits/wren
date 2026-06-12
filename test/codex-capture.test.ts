import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Config, saveProjects } from "../src/config.ts";
import { listPending } from "../src/queue/queue.ts";
import { cleanup, makeTmpConfig } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/** Run the codex-capture hook in a child process with isolated config/data dirs. */
async function runHook(cfg: Config, emptyCodexHome: string, payload: unknown): Promise<void> {
  const proc = Bun.spawn(["bun", "run", CLI, "hook", "codex-capture"], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: {
      ...process.env,
      WREN_CONFIG_DIR: cfg.configDir,
      WREN_DATA_DIR: cfg.dataDir,
      WREN_FAKE_EXTRACTOR: "1",
      CODEX_HOME: emptyCodexHome, // so the by-cwd fallback finds nothing
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

describe("codex-capture payload contract", () => {
  let cfg: Config;
  let project: string;
  let emptyCodexHome: string;

  beforeEach(async () => {
    cfg = makeTmpConfig();
    project = join(cfg.dataDir, "proj");
    emptyCodexHome = join(cfg.dataDir, "codex-home");
    await mkdir(project, { recursive: true });
    await mkdir(emptyCodexHome, { recursive: true });
    await saveProjects(cfg, { projects: { [project]: { enabled: true, added: "2026-06-12" } } });
  });
  afterEach(async () => {
    await cleanup(cfg);
  });

  it("uses the documented transcript_path directly (no cwd scan)", async () => {
    const transcriptPath = join(project, "rollout-doc.jsonl");
    await runHook(cfg, emptyCodexHome, {
      hook_event_name: "Stop",
      session_id: "s-doc",
      transcript_path: transcriptPath,
      cwd: project,
    });

    const pending = await listPending(cfg);
    expect(pending.length).toBe(1);
    expect(pending[0]?.job.agent).toBe("codex");
    expect(pending[0]?.job.sessionId).toBe("s-doc");
    expect(pending[0]?.job.transcriptPath).toBe(transcriptPath);
  });

  it("no-ops when transcript_path is null and no rollout is discoverable", async () => {
    await runHook(cfg, emptyCodexHome, {
      hook_event_name: "Stop",
      session_id: "s-null",
      transcript_path: null,
      cwd: project,
    });

    expect((await listPending(cfg)).length).toBe(0);
  });
});
