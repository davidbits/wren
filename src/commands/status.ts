/** `wren status` — quick health view: config, projects, queue, index. */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Config, loadProjects } from "../config.ts";
import { MemoryIndex } from "../vault/index.ts";

async function countDir(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export async function status(cfg: Config): Promise<void> {
  const reg = await loadProjects(cfg);
  const projects = Object.entries(reg.projects);

  console.log("wren status\n");
  console.log(`vault:        ${cfg.vaultPath}`);
  console.log(`data:         ${cfg.dataDir}`);
  console.log(`codex home:   ${cfg.codexHome}`);
  console.log(
    `extractor:    ${cfg.fakeExtractor ? "FAKE (offline)" : `codex (${cfg.extractorModel ?? "default model"})`}`,
  );

  console.log(`\nprojects (${projects.length}):`);
  if (!projects.length) console.log("  (none — run: wren enable <path>)");
  for (const [path, entry] of projects) {
    console.log(`  ${entry.enabled ? "●" : "○"} ${path}`);
  }

  const pending = await countDir(join(cfg.queueDir, "pending"));
  const failed = await countDir(join(cfg.queueDir, "failed"));
  console.log(`\nqueue:        ${pending} pending, ${failed} failed`);

  try {
    const index = await MemoryIndex.open(cfg.indexDbPath);
    console.log(`index:        ${index.count()} memories`);
    index.close();
  } catch {
    console.log("index:        (not built yet — run: wren rebuild)");
  }
}
