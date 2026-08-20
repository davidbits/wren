import { afterEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { resolveExtractorProvenance } from "../src/extractor/run.ts";
import { cleanup, makeTmpConfig } from "./helpers.ts";

describe("extractor provenance", () => {
  let cfg: Config | undefined;

  afterEach(async () => {
    if (cfg) await cleanup(cfg);
    cfg = undefined;
  });

  it("resolves the inherited Codex account home and configured defaults", async () => {
    cfg = makeTmpConfig();
    cfg.codexHome = "/home/x/.codex-transcripts";
    cfg.fakeExtractor = false;
    const accountHome = join(cfg.dataDir, "..", "account-home");
    await mkdir(accountHome, { recursive: true });
    await Bun.write(
      join(accountHome, "config.toml"),
      'model = "gpt-account"\nmodel_reasoning_effort = "medium"\nmodel_provider = "openai"\n',
    );

    const provenance = await resolveExtractorProvenance(cfg, { CODEX_HOME: accountHome });

    expect(provenance).toEqual({
      engine: "codex",
      binary: "codex",
      codex_home: accountHome,
      transcript_home: "/home/x/.codex-transcripts",
      model: "gpt-account",
      reasoning_effort: "medium",
      model_provider: "openai",
    });
  });

  it("records command-line model and reasoning overrides", async () => {
    cfg = makeTmpConfig();
    cfg.fakeExtractor = false;
    cfg.extractorModel = "gpt-wren-config";

    const provenance = await resolveExtractorProvenance(cfg, {
      CODEX_HOME: join(cfg.dataDir, "..", "missing-account-home"),
      WREN_CODEX_ARGS: "--model gpt-command -c model_reasoning_effort=high",
    });

    expect(provenance.model).toBe("gpt-command");
    expect(provenance.reasoning_effort).toBe("high");
  });

  it("resolves a selected profile below explicit command overrides", async () => {
    cfg = makeTmpConfig();
    cfg.fakeExtractor = false;
    const accountHome = join(cfg.dataDir, "..", "profile-account-home");
    await mkdir(accountHome, { recursive: true });
    await Bun.write(
      join(accountHome, "config.toml"),
      'model = "gpt-user"\nmodel_reasoning_effort = "low"\n',
    );
    await Bun.write(
      join(accountHome, "batch.config.toml"),
      'model = "gpt-profile"\nmodel_reasoning_effort = "medium"\n',
    );

    const provenance = await resolveExtractorProvenance(cfg, {
      CODEX_HOME: accountHome,
      WREN_CODEX_ARGS: "--profile batch -c model_reasoning_effort=high",
    });

    expect(provenance.model).toBe("gpt-profile");
    expect(provenance.reasoning_effort).toBe("high");
    expect(provenance.profile).toBe("batch");
  });
});
