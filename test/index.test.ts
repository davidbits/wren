import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "../src/config.ts";
import type { MemoryNote } from "../src/types.ts";
import { MemoryIndex, toMatchExpr } from "../src/vault/index.ts";
import { cleanup, makeTmpConfig } from "./helpers.ts";

function note(id: string, scope: string, title: string, body: string): MemoryNote {
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

  it("recent falls back when query has no usable tokens", () => {
    index.upsertNote(note("1", "/p", "title", "body"));
    expect(toMatchExpr("()")).toBe("");
    const hits = index.search("()");
    expect(hits.length).toBe(1);
  });
});
