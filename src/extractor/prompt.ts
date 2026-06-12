/**
 * Builds the extraction prompt fed to `codex exec` on stdin.
 *
 * The prompt carries: the task + significance gate, the existing scoped learnings
 * (for write-time dedup), the hard no-secrets rule, and the secret-scrubbed,
 * size-capped normalized transcript.
 */
import type { MemoryNote, NormalizedTranscript, NormalizedTurn } from "../types.ts";
import { scrub } from "../util/secrets.ts";

/** Total transcript character budget; middle is elided if exceeded. */
const TRANSCRIPT_BUDGET = 60_000;
const HEAD = 8_000;

function renderTurn(turn: NormalizedTurn): string {
  const parts: string[] = [];
  if (turn.text.trim()) parts.push(turn.text.trim());
  for (const call of turn.toolCalls ?? []) {
    parts.push(`«tool:${call.name}»${call.input ? ` ${call.input}` : ""}`);
  }
  const tag = turn.role.toUpperCase();
  return `### ${tag}\n${parts.join("\n")}`;
}

export function renderTranscript(t: NormalizedTranscript): string {
  const full = t.turns.map(renderTurn).join("\n\n");
  if (full.length <= TRANSCRIPT_BUDGET) return full;
  const tail = TRANSCRIPT_BUDGET - HEAD;
  return `${full.slice(0, HEAD)}\n\n…[transcript middle elided]…\n\n${full.slice(-tail)}`;
}

function renderExisting(existing: MemoryNote[]): string {
  if (!existing.length) return "(none yet)";
  return existing
    .slice(0, 80)
    .map((n) => {
      const fm = n.frontmatter;
      const firstLine = n.body.split("\n")[0] ?? "";
      return `- id=${fm.id} [${fm.type}/${fm.scope === "global" ? "global" : "project"}] ${fm.title}: ${firstLine}`;
    })
    .join("\n");
}

export function buildPrompt(
  transcript: NormalizedTranscript,
  scope: string,
  existing: MemoryNote[],
): string {
  const body = scrub(renderTranscript(transcript));
  return `You are a memory extractor for AI coding agents. Read a finished agent session
transcript and extract DURABLE knowledge worth recalling in future sessions.

PROJECT SCOPE: ${scope}
AGENT: ${transcript.agent}

## Your job
1. SIGNIFICANCE GATE first. Set "durable": false (and empty "learnings") if the
   session taught nothing reusable — trivial chats, pure Q&A, aborted work,
   no decisions, no fixes, no preferences. Most short sessions are NOT durable.
2. If durable, produce:
   - A "session" audit note (objective, files touched, notable commands, outcome).
   - Zero or more ATOMIC "learnings" — each ONE self-contained, reusable fact:
     a fixed bug + its fix, a stated user preference, a project decision/convention,
     a tooling quirk, a non-obvious gotcha. NOT a play-by-play of the session.

## Learning quality
- Atomic: one fact per learning. Concrete and actionable.
- title: short imperative. text: the fact. why: when it matters. how_to_apply: what to do.
- scope: use "${scope}" for project-specific facts, or "global" for cross-project
  facts (user preferences, editor/tooling quirks, personal conventions).
- type: learning | preference | decision | failure.

## Dedup against existing memories (IMPORTANT)
These learnings already exist for this scope. Do NOT duplicate them.
- If you'd restate one, instead set "id" to its id to UPDATE it in place.
- If a new fact CONTRADICTS/OBSOLETES one, set "supersedes" to that id.
- Otherwise omit id/supersedes for a genuinely new learning.

EXISTING LEARNINGS:
${renderExisting(existing)}

## Hard rules
- NEVER include secrets, API keys, tokens, passwords, or credentials in output.
- Output MUST conform to the provided JSON schema. No prose outside the JSON.

## TRANSCRIPT
${body}
`;
}
