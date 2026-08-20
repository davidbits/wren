import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";

export function makeTmpConfig(): Config {
  const base = join(tmpdir(), `wren-test-${randomUUID()}`);
  const dataDir = join(base, "data");
  return {
    configDir: join(base, "config"),
    dataDir,
    vaultPath: join(base, "vault"),
    queueDir: join(dataDir, "queue"),
    indexDbPath: join(dataDir, "index.db"),
    codexBin: "codex",
    codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    extractorModel: undefined,
    maxInject: 15,
    settleMs: 180_000,
    codexRecaptureMs: 3_600_000,
    fakeExtractor: true,
  };
}

export async function cleanup(cfg: Config): Promise<void> {
  // base dir is the parent of dataDir.
  await rm(join(cfg.dataDir, ".."), { recursive: true, force: true });
}
