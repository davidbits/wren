/** Rebuild the derived SQLite index from the markdown vault. */
import type { Config } from "../config.ts";
import { logger } from "../util/log.ts";
import { MemoryIndex } from "./index.ts";
import { readAllNotes } from "./store.ts";

const log = logger("rebuild");

export async function rebuildIndex(cfg: Config): Promise<number> {
  const index = await MemoryIndex.open(cfg.indexDbPath);
  try {
    index.clear();
    let n = 0;
    for (const note of await readAllNotes(cfg)) {
      // Superseded and deleted notes stay on disk for audit but remain inactive.
      if (note.frontmatter.superseded_by || note.frontmatter.deleted) continue;
      index.upsertNote(note);
      n++;
    }
    log.info("index rebuilt", { notes: n });
    return n;
  } finally {
    index.close();
  }
}
