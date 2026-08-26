import type { Config } from "../config.ts";
import type { MemoryNote, MemoryType } from "../types.ts";
import type { MemoryIndex } from "./index.ts";
import { serializeNote } from "./note.ts";
import { findNoteById, readAllNotes } from "./store.ts";

export type DeleteTarget = "memory" | "session";

export type DeleteResult =
  | { status: "deleted"; note: MemoryNote; deleted: MemoryNote[]; deletedAt: string }
  | { status: "not_found" }
  | { status: "wrong_type"; actualType: MemoryType };

interface DeleteOptions {
  scopes?: string[];
  nowIso?: string;
}

/** Soft-delete one memory, or one session and every memory extracted from it. */
export async function softDeleteById(
  cfg: Config,
  index: MemoryIndex,
  id: string,
  target: DeleteTarget,
  options: DeleteOptions = {},
): Promise<DeleteResult> {
  const note = await findNoteById(cfg, id);
  if (
    !note ||
    note.frontmatter.deleted ||
    (options.scopes?.length && !options.scopes.includes(note.frontmatter.scope))
  ) {
    return { status: "not_found" };
  }

  const isSession = note.frontmatter.type === "session";
  if ((target === "session") !== isSession) {
    return { status: "wrong_type", actualType: note.frontmatter.type };
  }

  const deleted =
    target === "session"
      ? (await readAllNotes(cfg)).filter(
          (candidate) =>
            candidate.frontmatter.source_session === note.frontmatter.source_session &&
            !candidate.frontmatter.deleted,
        )
      : [note];
  const deletedAt = options.nowIso ?? new Date().toISOString();

  for (const candidate of deleted) {
    candidate.frontmatter.deleted = deletedAt;
    await Bun.write(candidate.path, serializeNote(candidate.frontmatter, candidate.body));
    index.remove(candidate.frontmatter.id);
  }

  return { status: "deleted", note, deleted, deletedAt };
}
