/**
 * Extractor runner.
 *
 * The extractor LLM is always `codex exec` (D6), regardless of which agent
 * produced the transcript. It is invoked headless with `--output-schema` so the
 * final message is schema-valid JSON, written to a file with `-o`, then validated
 * with zod before we trust it.
 *
 * A local heuristic fallback (`WREN_FAKE_EXTRACTOR=1`) lets the full
 * pipeline be exercised offline without spending Codex quota.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { ExtractionResult, MemoryNote, NormalizedTranscript } from "../types.ts";
import { logger } from "../util/log.ts";
// Imported (not read from disk) so it's bundled into the compiled binary, which
// has no source tree. `codex exec --output-schema` needs a real path, so we
// materialize it to a temp file at runtime (see runCodex).
import schema from "./memory.schema.json";
import { buildPrompt } from "./prompt.ts";

const log = logger("extractor");

// The schema is OpenAI-strict (every key required; optionals are nullable), so we
// accept null here and normalize null → undefined into our internal types.
const nullableStr = z
  .string()
  .nullish()
  .transform((v) => v ?? undefined);

const LearningSchema = z.object({
  id: nullableStr,
  type: z.enum(["learning", "preference", "decision", "failure"]),
  scope: z.string(),
  title: z.string(),
  text: z.string(),
  why: z.string(),
  how_to_apply: z.string(),
  tags: z.array(z.string()).default([]),
  supersedes: nullableStr,
});

const ResultSchema = z.object({
  durable: z.boolean(),
  session: z
    .object({
      objective: z.string(),
      files_touched: z.array(z.string()).default([]),
      commands: z.array(z.string()).default([]),
      outcome: z.string(),
      tags: z.array(z.string()).default([]),
    })
    .nullish()
    .transform((v) => v ?? undefined),
  learnings: z.array(LearningSchema).default([]),
});

export async function extract(
  cfg: Config,
  transcript: NormalizedTranscript,
  scope: string,
  existing: MemoryNote[],
): Promise<ExtractionResult> {
  const prompt = buildPrompt(transcript, scope, existing);
  if (cfg.fakeExtractor) {
    log.warn("using FAKE extractor (no LLM)");
    return fakeExtract(transcript, scope);
  }
  return runCodex(cfg, prompt);
}

async function runCodex(cfg: Config, prompt: string): Promise<ExtractionResult> {
  const tmpDir = join(cfg.dataDir, "tmp");
  await mkdir(tmpDir, { recursive: true });
  const outPath = join(tmpDir, `extract-${randomUUID()}.json`);

  // Materialize the bundled schema to a real file for `codex exec --output-schema`.
  const schemaPath = join(tmpDir, "memory.schema.json");
  await Bun.write(schemaPath, JSON.stringify(schema));

  // `codex exec` is non-interactive (no approval prompts); a read-only sandbox is
  // plenty since extraction only needs the model to emit JSON, not run tools.
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "--output-schema",
    schemaPath,
    "-o",
    outPath,
  ];
  if (cfg.extractorModel) args.push("-m", cfg.extractorModel);
  const extra = process.env.WREN_CODEX_ARGS;
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));

  log.info("running codex exec", { bin: cfg.codexBin, model: cfg.extractorModel });
  const proc = Bun.spawn([cfg.codexBin, ...args], {
    stdin: Buffer.from(prompt),
    stdout: "pipe",
    stderr: "pipe",
    cwd: tmpDir,
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

  try {
    if (exitCode !== 0) {
      throw new Error(`codex exec exited ${exitCode}: ${stderr.slice(-2000)}`);
    }
    const file = Bun.file(outPath);
    if (!(await file.exists())) {
      throw new Error(`codex produced no output file (stderr: ${stderr.slice(-1000)})`);
    }
    return parseResult(await file.text());
  } finally {
    await rm(outPath, { force: true });
  }
}

/** Parse + validate the model's JSON. Tolerates stray prose around the object. */
export function parseResult(raw: string): ExtractionResult {
  const json = extractJsonObject(raw);
  const parsed = ResultSchema.parse(json);
  // If not durable, force-empty so the writer is a no-op regardless of model noise.
  if (!parsed.durable) return { durable: false, learnings: [] };
  return parsed as ExtractionResult;
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Salvage the outermost {...} if the model wrapped it.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("extractor output is not valid JSON");
  }
}

/**
 * Offline heuristic extractor. Clearly marked as such in its output — it exists
 * to exercise the capture→store pipeline end-to-end without an LLM.
 */
export function fakeExtract(t: NormalizedTranscript, scope: string): ExtractionResult {
  const userTurns = t.turns.filter((x) => x.role === "user" && x.text.trim());
  const assistantTurns = t.turns.filter((x) => x.role === "assistant" && x.text.trim());
  if (t.turns.length < 2 || userTurns.length === 0) {
    return { durable: false, learnings: [] };
  }
  const clip = (s: string, n = 200) => s.replace(/\s+/g, " ").slice(0, n);
  const objective = clip(userTurns[0]?.text ?? "unknown");
  const outcome = clip(assistantTurns.at(-1)?.text ?? "unknown");

  const commands: string[] = [];
  for (const turn of t.turns) {
    for (const call of turn.toolCalls ?? []) {
      if (/^(bash|shell)$/i.test(call.name) && call.input) commands.push(clip(call.input, 120));
    }
  }

  return {
    durable: true,
    session: {
      objective,
      files_touched: [],
      commands: commands.slice(0, 5),
      outcome,
      tags: ["fake-extractor"],
    },
    learnings: [
      {
        type: "learning",
        scope,
        title: `Heuristic capture: ${clip(objective, 60)}`,
        text: `[fake-extractor] Session worked on: ${objective}`,
        why: "Placeholder produced without an LLM; replace by running the real extractor.",
        how_to_apply: "Set WREN_FAKE_EXTRACTOR=0 and configure Codex to get real learnings.",
        tags: ["fake-extractor"],
      },
    ],
  };
}
