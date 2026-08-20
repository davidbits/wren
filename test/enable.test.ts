import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { enableProject } from "../src/commands/enable.ts";
import type { Config } from "../src/config.ts";
import { cleanup, makeTmpConfig } from "./helpers.ts";

describe("project enable", () => {
  let cfg: Config | undefined;
  const codexHomes: string[] = [];

  afterEach(async () => {
    if (cfg) await cleanup(cfg);
    await Promise.all(
      codexHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("configures every supplied Codex home", async () => {
    cfg = makeTmpConfig();
    const project = join(cfg.dataDir, "project");
    await mkdir(project, { recursive: true });
    codexHomes.push(join(cfg.dataDir, "codex-a"), join(cfg.dataDir, "codex-b"));

    await enableProject(cfg, project, { codex: true, codexHomes });

    for (const home of codexHomes) {
      const config = parse(await Bun.file(join(home, "config.toml")).text()) as {
        projects?: Record<string, { trust_level?: string }>;
      };
      expect(config.projects?.[project]?.trust_level).toBe("trusted");
    }
    expect(await Bun.file(join(project, ".codex", "hooks.json")).exists()).toBe(true);
  });
});
