/** Adapter dispatch + transcript hashing (for queue idempotency). */
import type { Agent, NormalizedTranscript } from "../types.ts";
import { parseClaudeTranscript } from "./claude.ts";
import { parseCodexTranscript } from "./codex.ts";

export async function parseTranscript(agent: Agent, path: string): Promise<NormalizedTranscript> {
  switch (agent) {
    case "claude-code":
      return parseClaudeTranscript(path);
    case "codex":
      return parseCodexTranscript(path);
  }
}

/** Content hash of a transcript file — used to skip re-processing settled work. */
export async function hashTranscript(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}
