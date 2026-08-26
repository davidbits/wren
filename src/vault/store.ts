/** Read-side helpers over the markdown vault. */
import type { Config } from "../config.ts";
import type { MemoryNote } from "../types.ts";
import { readNote } from "./note.ts";
import { learningsDir, walkNotes } from "./paths.ts";

/** All learning notes for the given scopes (e.g. a project + "global"). */
export async function readLearnings(cfg: Config, scopes: string[]): Promise<MemoryNote[]> {
  const out: MemoryNote[] = [];
  for (const scope of scopes) {
    for await (const path of walkNotes(learningsDir(cfg, scope))) {
      const note = await readNote(path);
      if (note && !note.frontmatter.deleted) out.push(note);
    }
  }
  return out;
}

/** Find a note anywhere in the vault by its frontmatter id. */
export async function findNoteById(cfg: Config, id: string): Promise<MemoryNote | null> {
  for await (const path of walkNotes(cfg.vaultPath)) {
    const note = await readNote(path);
    if (note?.frontmatter.id === id) return note;
  }
  return null;
}

/** Every note in the vault — used by `rebuild` to repopulate the index. */
export async function readAllNotes(cfg: Config): Promise<MemoryNote[]> {
  const out: MemoryNote[] = [];
  for await (const path of walkNotes(cfg.vaultPath)) {
    const note = await readNote(path);
    if (note) out.push(note);
  }
  return out;
}

/** Convenience: the standard scope set for a project cwd (project + global). */
export function scopesFor(scope: string): string[] {
  return scope === "global" ? ["global"] : [scope, "global"];
}
