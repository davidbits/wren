import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "../src/config.ts";
import { fakeExtract } from "../src/extractor/run.ts";
import type { ExtractionResult, NormalizedTranscript } from "../src/types.ts";
import { MemoryIndex } from "../src/vault/index.ts";
import { readNote } from "../src/vault/note.ts";
import { readLearnings } from "../src/vault/store.ts";
import { writeExtraction } from "../src/vault/write.ts";
import { cleanup, makeTmpConfig } from "./helpers.ts";

const SCOPE = "/home/x/proj";

function baseResult(): ExtractionResult {
  return {
    durable: true,
    session: {
      objective: "Wire up the queue",
      files_touched: ["src/queue/queue.ts"],
      commands: ["bun test"],
      outcome: "It works",
      tags: ["queue"],
    },
    learnings: [
      {
        type: "learning",
        scope: SCOPE,
        title: "Use atomic rename for the queue",
        text: "Write to a temp file then rename for crash safety.",
        why: "A crash mid-write must not corrupt a job.",
        how_to_apply: "writeFile(tmp); rename(tmp, dest).",
        tags: ["queue", "durability"],
      },
    ],
  };
}

describe("vault write pipeline", () => {
  let cfg: Config;
  let index: MemoryIndex;

  beforeEach(async () => {
    cfg = makeTmpConfig();
    index = await MemoryIndex.open(cfg.indexDbPath);
  });
  afterEach(async () => {
    index.close();
    await cleanup(cfg);
  });

  it("writes a session note + learning and indexes them", async () => {
    const result = baseResult();
    result.extractor = {
      engine: "codex",
      binary: "codex",
      codex_home: "/home/x/.codex-work",
      transcript_home: "/home/x/.codex-transcripts",
      model: "gpt-test",
      reasoning_effort: "medium",
    };
    const summary = await writeExtraction(cfg, index, {
      result,
      agent: "claude-code",
      sessionId: "abcdef123456",
      scope: SCOPE,
      nowIso: "2026-06-10T12:00:00.000Z",
    });
    expect(summary.written).toBe(true);
    expect(summary.learningPaths.length).toBe(1);
    expect(summary.sessionNotePath).toBeDefined();

    // Note exists on disk and parses.
    const note = await readNote(summary.learningPaths[0]!);
    expect(note?.frontmatter.type).toBe("learning");
    expect(note?.frontmatter.title).toBe("Use atomic rename for the queue");
    expect(note?.body).toContain("temp file then rename");
    expect(note?.body).toContain("Related: [[session-");
    expect(note?.frontmatter.extracted).toBe("2026-06-10T12:00:00.000Z");
    expect(note?.frontmatter.extractor).toEqual(result.extractor);

    const session = await readNote(summary.sessionNotePath!);
    expect(session?.frontmatter.extractor).toEqual(result.extractor);

    // Indexed + searchable.
    const hits = index.search("rename", { scopes: [SCOPE, "global"] });
    expect(hits.some((h) => h.title.includes("atomic rename"))).toBe(true);
  });

  it("skips writing when not durable", async () => {
    const summary = await writeExtraction(cfg, index, {
      result: { durable: false, learnings: [] },
      agent: "claude-code",
      sessionId: "s",
      scope: SCOPE,
      nowIso: "2026-06-10T12:00:00.000Z",
    });
    expect(summary.written).toBe(false);
    expect(index.count()).toBe(0);
  });

  it("supersedes a prior learning", async () => {
    await writeExtraction(cfg, index, {
      result: baseResult(),
      agent: "claude-code",
      sessionId: "s1",
      scope: SCOPE,
      nowIso: "2026-06-10T12:00:00.000Z",
    });
    const before = await readLearnings(cfg, [SCOPE, "global"]);
    const oldId = before[0]!.frontmatter.id;

    const result = baseResult();
    result.session = undefined;
    result.learnings[0]!.title = "Prefer rename(2) for atomic queue writes";
    result.learnings[0]!.supersedes = oldId;

    await writeExtraction(cfg, index, {
      result,
      agent: "claude-code",
      sessionId: "s2",
      scope: SCOPE,
      nowIso: "2026-06-10T13:00:00.000Z",
    });

    // Old note flagged superseded + removed from index; new note live.
    const all = await readLearnings(cfg, [SCOPE, "global"]);
    const old = all.find((n) => n.frontmatter.id === oldId);
    expect(old?.frontmatter.superseded_by).toBeDefined();
    expect(index.get(oldId)).toBeNull();
    const hits = index
      .search("rename", { scopes: [SCOPE, "global"] })
      .filter((h) => h.type === "learning");
    expect(hits.length).toBe(1);
    expect(hits[0]?.title).toContain("Prefer rename");
  });

  it("uses collision-safe paths and preserves session identity on revision", async () => {
    const firstResult = baseResult();
    firstResult.learnings = [];
    const first = await writeExtraction(cfg, index, {
      result: firstResult,
      agent: "codex",
      sessionId: "01a01e25-0b9c-72d2-842f-daeb58da6c6d",
      scope: SCOPE,
      nowIso: "2026-06-10T12:00:00.000Z",
    });
    const firstNote = await readNote(first.sessionNotePath!);

    const revisionResult = baseResult();
    revisionResult.learnings = [];
    revisionResult.session!.outcome = "Revised outcome";
    const revision = await writeExtraction(cfg, index, {
      result: revisionResult,
      agent: "codex",
      sessionId: "01a01e25-0b9c-72d2-842f-daeb58da6c6d",
      scope: SCOPE,
      nowIso: "2026-06-11T12:00:00.000Z",
    });
    const revisionNote = await readNote(revision.sessionNotePath!);

    const siblingResult = baseResult();
    siblingResult.learnings = [];
    const sibling = await writeExtraction(cfg, index, {
      result: siblingResult,
      agent: "codex",
      sessionId: "01a01e43-7459-76a3-a081-cf534deac854",
      scope: SCOPE,
      nowIso: "2026-06-10T13:00:00.000Z",
    });

    expect(revision.sessionNotePath).toBe(first.sessionNotePath);
    expect(sibling.sessionNotePath).not.toBe(first.sessionNotePath);
    expect(revisionNote?.frontmatter.id).toBe(firstNote?.frontmatter.id);
    expect(revisionNote?.frontmatter.created).toBe(firstNote?.frontmatter.created);
    expect(revisionNote?.body).toContain("Revised outcome");
    expect(index.count()).toBe(2);
  });

  it("fakeExtract gates trivial transcripts", () => {
    const empty: NormalizedTranscript = {
      agent: "claude-code",
      sessionId: "s",
      cwd: SCOPE,
      turns: [],
    };
    expect(fakeExtract(empty, SCOPE).durable).toBe(false);

    const real: NormalizedTranscript = {
      agent: "claude-code",
      sessionId: "s",
      cwd: SCOPE,
      turns: [
        { role: "user", text: "fix the bug" },
        { role: "assistant", text: "fixed it" },
      ],
    };
    expect(fakeExtract(real, SCOPE).durable).toBe(true);
  });
});
