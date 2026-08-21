import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "../src/config.ts";
import type { MemoryNote } from "../src/types.ts";
import { MemoryIndex, toMatchExpr } from "../src/vault/index.ts";
import { cleanup, makeTmpConfig } from "./helpers.ts";

function note(
  id: string,
  scope: string,
  title: string,
  body: string,
  overrides: Partial<MemoryNote["frontmatter"]> = {},
): MemoryNote {
  return {
    frontmatter: {
      id,
      type: "learning",
      scope,
      agent: "claude-code",
      created: `2026-06-10T12:00:0${id.slice(-1)}.000Z`,
      source_session: "s",
      title,
      tags: ["x"],
      ...overrides,
    },
    body,
    path: `/tmp/${id}.md`,
  };
}

describe("MemoryIndex", () => {
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

  it("indexes and full-text searches", () => {
    index.upsertNote(note("1", "/p", "SQLite FTS5 quirks", "Use porter tokenizer for stemming"));
    index.upsertNote(note("2", "/p", "Bun spawn stdin", "Pass a Buffer as stdin to subprocess"));
    expect(index.count()).toBe(2);

    const hits = index.search("tokenizer");
    expect(hits.length).toBe(1);
    expect(hits[0]?.id).toBe("1");
  });

  it("scopes search", () => {
    index.upsertNote(note("1", "/a", "alpha thing", "alpha body content"));
    index.upsertNote(note("2", "/b", "alpha thing", "alpha body content"));
    const hits = index.search("alpha", { scopes: ["/a"] });
    expect(hits.length).toBe(1);
    expect(hits[0]?.scope).toBe("/a");
  });

  it("upsert replaces by id (no dupes)", () => {
    index.upsertNote(note("1", "/p", "v1", "first version"));
    index.upsertNote(note("1", "/p", "v2", "second version"));
    expect(index.count()).toBe(1);
    expect(index.get("1")?.title).toBe("v2");
  });

  it("upsert replaces a prior id at the same vault path", () => {
    const first = note("1", "/p", "v1", "first version");
    const second = note("2", "/p", "v2", "second version");
    second.path = first.path;
    index.upsertNote(first);
    index.upsertNote(second);
    expect(index.count()).toBe(1);
    expect(index.get("1")).toBeNull();
    expect(index.get("2")?.title).toBe("v2");
  });

  it("recent falls back when query has no usable tokens", () => {
    index.upsertNote(note("1", "/p", "title", "body"));
    expect(toMatchExpr("()")).toBe("");
    const hits = index.search("()");
    expect(hits.length).toBe(1);
  });

  it("explores bounded session, concept, and text pathways", () => {
    index.upsertNote(
      note("seed", "/p", "Atomic queue writes", "Write temp files before rename", {
        source_session: "session-a",
        tags: ["queue", "safety"],
      }),
    );
    index.upsertNote(
      note("sibling", "/p", "Recover interrupted writes", "Clean abandoned temp files", {
        source_session: "session-a",
        tags: ["recovery"],
      }),
    );
    index.upsertNote(
      note("concept", "/p", "Serialize queue workers", "Use one writer", {
        source_session: "session-b",
        tags: ["queue"],
      }),
    );
    index.upsertNote(
      note("other-scope", "/other", "Queue elsewhere", "Must stay out", {
        source_session: "session-c",
        tags: ["queue"],
      }),
    );

    expect(index.explore("seed", "same_session", { scopes: ["/p"] }).map((h) => h.id)).toEqual([
      "sibling",
    ]);
    expect(
      index
        .explore("seed", "shared_concept", { scopes: ["/p"], concept: "queue" })
        .map((h) => h.id),
    ).toEqual(["concept"]);
    expect(
      index
        .explore("seed", "similar_text", { scopes: ["/p"], visited: ["concept"] })
        .map((h) => h.id),
    ).not.toContain("concept");
    expect(index.explore("seed", "same_session", { scopes: ["/other"] })).toEqual([]);
  });
});
