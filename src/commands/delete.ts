import type { Config } from "../config.ts";
import { type DeleteTarget, softDeleteById } from "../vault/delete.ts";
import { MemoryIndex } from "../vault/index.ts";

export async function deleteById(cfg: Config, target: DeleteTarget, id: string): Promise<void> {
  const index = await MemoryIndex.open(cfg.indexDbPath);
  try {
    const result = await softDeleteById(cfg, index, id, target);
    if (result.status === "not_found") throw new Error(`No ${target} with id ${id}.`);
    if (result.status === "wrong_type") {
      throw new Error(`ID ${id} is ${result.actualType}, not ${target}.`);
    }
    const memories = result.deleted.filter((note) => note.frontmatter.type !== "session").length;
    const suffix = target === "session" ? ` and ${memories} memory(s)` : "";
    console.log(`Soft-deleted ${target} ${id}${suffix}.`);
  } finally {
    index.close();
  }
}
