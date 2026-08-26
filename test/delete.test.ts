import { describe, expect, it } from "bun:test";
import { softDeleteById } from "../src/vault/delete.ts";
import { MemoryIndex } from "../src/vault/index.ts";
import { readNote } from "../src/vault/note.ts";
import { rebuildIndex } from "../src/vault/rebuild.ts";
import { readAllNotes } from "../src/vault/store.ts";
import { writeExtraction } from "../src/vault/write.ts";
import { cleanup, makeTmpConfig } from "./helpers.ts";

async function seed() {
  const cfg = makeTmpConfig();
  const index = await MemoryIndex.open(cfg.indexDbPath);
  await writeExtraction(cfg, index, {
    result: {
      durable: true,
      session: {
        objective: "Test deletion",
        outcome: "Seeded notes",
        files_touched: [],
        commands: [],
        tags: ["delete"],
      },
      learnings: [
        {
          type: "learning",
          scope: cfg.vaultPath,
          title: "Delete seeded notes",
          text: "Delete notes by id.",
          why: "Test behavior.",
          how_to_apply: "Call deletion.",
          tags: ["delete"],
        },
      ],
    },
    agent: "codex",
    sessionId: "delete-session",
    scope: cfg.vaultPath,
    nowIso: "2026-08-26T10:00:00.000Z",
  });
  return { cfg, index };
}

describe("softDeleteById", () => {
  it("soft-deletes a memory but keeps its vault note", async () => {
    const { cfg, index } = await seed();
    try {
      const notes = await readAllNotes(cfg);
      const memory = notes.find((note) => note.frontmatter.type !== "session")!;
      const result = await softDeleteById(cfg, index, memory.frontmatter.id, "memory", {
        nowIso: "2026-08-26T11:00:00.000Z",
      });
      expect(result.status).toBe("deleted");
      expect(index.get(memory.frontmatter.id)).toBeNull();
      expect((await readNote(memory.path))?.frontmatter.deleted).toBe("2026-08-26T11:00:00.000Z");
      await rebuildIndex(cfg);
      expect(index.get(memory.frontmatter.id)).toBeNull();
    } finally {
      index.close();
      await cleanup(cfg);
    }
  });

  it("soft-deletes a session and every memory from its source session", async () => {
    const { cfg, index } = await seed();
    try {
      const notes = await readAllNotes(cfg);
      const memory = notes.find((note) => note.frontmatter.type !== "session")!;
      const session = notes.find((note) => note.frontmatter.type === "session")!;

      expect(await softDeleteById(cfg, index, session.frontmatter.id, "memory")).toEqual({
        status: "wrong_type",
        actualType: "session",
      });
      const result = await softDeleteById(cfg, index, session.frontmatter.id, "session", {
        nowIso: "2026-08-26T11:00:00.000Z",
      });
      expect(result.status).toBe("deleted");
      expect(result.status === "deleted" && result.deleted).toHaveLength(2);
      expect(index.get(session.frontmatter.id)).toBeNull();
      expect(index.get(memory.frontmatter.id)).toBeNull();
      expect((await readNote(session.path))?.frontmatter.deleted).toBeDefined();
      expect((await readNote(memory.path))?.frontmatter.deleted).toBeDefined();

      const rewrite = await writeExtraction(cfg, index, {
        result: {
          durable: true,
          session: {
            objective: "Recapture deleted session",
            outcome: "Must remain deleted",
            files_touched: [],
            commands: [],
            tags: [],
          },
          learnings: [
            {
              type: "learning",
              scope: cfg.vaultPath,
              title: "Do not recreate me",
              text: "Deleted session tombstone remains active.",
              why: "Deletion must persist.",
              how_to_apply: "Skip write.",
              tags: [],
            },
          ],
        },
        agent: "codex",
        sessionId: "delete-session",
        scope: cfg.vaultPath,
        nowIso: "2026-08-26T12:00:00.000Z",
      });
      expect(rewrite.written).toBe(false);
      expect(index.count()).toBe(0);
    } finally {
      index.close();
      await cleanup(cfg);
    }
  });
});
