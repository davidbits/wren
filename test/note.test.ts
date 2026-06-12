import { describe, expect, it } from "bun:test";
import type { MemoryFrontmatter } from "../src/types.ts";
import { parseNote, serializeNote } from "../src/vault/note.ts";

const fm: MemoryFrontmatter = {
  id: "01ABC",
  type: "learning",
  scope: "/home/x/proj",
  agent: "claude-code",
  created: "2026-06-10T12:00:00.000Z",
  source_session: "sess-1",
  title: "Use bun for everything",
  tags: ["bun", "tooling"],
};

describe("note serialize/parse", () => {
  it("round-trips frontmatter + body", () => {
    const body = "The fact.\n\n**Why:** because.\n**How to apply:** do it.";
    const doc = serializeNote(fm, body);
    expect(doc.startsWith("---\n")).toBe(true);

    const parsed = parseNote(doc, "/tmp/x.md");
    expect(parsed.frontmatter.id).toBe("01ABC");
    expect(parsed.frontmatter.type).toBe("learning");
    expect(parsed.frontmatter.tags).toEqual(["bun", "tooling"]);
    expect(parsed.body).toContain("The fact.");
    expect(parsed.body).toContain("**Why:**");
  });

  it("omits undefined optional fields", () => {
    const doc = serializeNote(fm, "body");
    expect(doc).not.toContain("supersedes");
    expect(doc).not.toContain("superseded_by");
  });

  it("throws on missing frontmatter", () => {
    expect(() => parseNote("no frontmatter here", "/tmp/x.md")).toThrow();
  });
});
