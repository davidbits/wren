/**
 * Shared types for the whole pipeline.
 *
 * The flow: a capture hook enqueues a {@link Job}. The worker reads the job,
 * runs the matching {@link TranscriptAdapter} to produce {@link NormalizedTurn}s,
 * feeds them to the extractor which returns an {@link ExtractionResult}, and the
 * vault writer persists that as markdown {@link MemoryNote}s.
 */

/** Which agent produced a transcript. The extractor LLM is always Codex (D6). */
export type Agent = "claude-code" | "codex";

/** Note kinds. `session` = audit note; the rest are atomic RAG learnings. */
export type MemoryType = "learning" | "preference" | "decision" | "failure" | "session";

/** Runtime identity of the extractor that produced a memory note. */
export interface ExtractorProvenance {
  engine: "codex" | "fake";
  /** Command configured for extraction (for example `codex` or an absolute path). */
  binary: string;
  /** Effective Codex config/auth home used by `codex exec`. */
  codex_home: string;
  /** Codex home from which Wren selected source transcripts. */
  transcript_home: string;
  /** Resolved model name, or `codex-default` when Codex owns the default. */
  model: string;
  reasoning_effort?: string;
  model_provider?: string;
  profile?: string;
}

/** A single tool invocation extracted from a transcript. */
export interface ToolCall {
  name: string;
  /** Best-effort short rendering of the tool input (already secret-scrubbed). */
  input?: string;
  /** Best-effort short rendering of the tool output (already secret-scrubbed). */
  output?: string;
}

/** Provider-agnostic conversation turn. Both adapters normalize to this. */
export interface NormalizedTurn {
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  toolCalls?: ToolCall[];
  ts?: string;
}

/** Normalized transcript plus the metadata the extractor needs. */
export interface NormalizedTranscript {
  agent: Agent;
  sessionId: string;
  cwd: string;
  turns: NormalizedTurn[];
  /** First/last timestamps if available. */
  startedAt?: string;
  endedAt?: string;
}

/** A unit of work appended to the durable queue by a capture hook. */
export interface Job {
  agent: Agent;
  transcriptPath: string;
  /** Original agent-owned path when transcriptPath points at Wren's spool. */
  sourceTranscriptPath?: string;
  /** Wren owns transcriptPath and may remove it after successful processing. */
  transcriptOwned?: boolean;
  cwd: string;
  sessionId: string;
  enqueuedAt: string;
  /** Hook-specific termination reason, when supplied by the agent. */
  reason?: string;
  /** Agent/subagent type supplied by the hook payload. */
  agentType?: string;
  /** Captured before extraction so done/failed records retain runtime provenance. */
  extractor?: ExtractorProvenance;
  /** Incremented by the worker on transient failure; capped before going to failed/. */
  attempt?: number;
}

/** Adapter contract: read a raw transcript file into the common shape. */
export interface TranscriptAdapter {
  agent: Agent;
  parse(transcriptPath: string): Promise<NormalizedTranscript>;
}

/**
 * One atomic learning the extractor proposes. Maps 1:1 to a markdown note.
 * `id` is assigned by the writer unless the extractor is updating an existing
 * note (then it echoes the id it was shown).
 */
export interface AtomicLearning {
  id?: string;
  type: Exclude<MemoryType, "session">;
  /** Absolute project path this applies to, or "global". */
  scope: string;
  /** Short imperative title — also the dedup key surface. */
  title: string;
  /** The durable fact, stated concisely. */
  text: string;
  why: string;
  how_to_apply: string;
  tags: string[];
  /** id of a prior note this replaces, if any. */
  supersedes?: string;
}

/** The audit note for a session. */
export interface SessionNote {
  objective: string;
  files_touched: string[];
  commands: string[];
  outcome: string;
  tags: string[];
}

/** Structured output the extractor LLM must return (see memory.schema.json). */
export interface ExtractionResult {
  /** Significance gate: false → write nothing. */
  durable: boolean;
  session?: SessionNote;
  learnings: AtomicLearning[];
  /** Added by Wren after model output validation; never supplied by the model. */
  extractor?: ExtractorProvenance;
}

/** Frontmatter persisted at the top of every note. */
export interface MemoryFrontmatter {
  id: string;
  type: MemoryType;
  scope: string;
  agent: Agent;
  created: string;
  source_session: string;
  title: string;
  tags: string[];
  /** Latest extraction/revision time and runtime provenance. */
  extracted?: string;
  extractor?: ExtractorProvenance;
  supersedes?: string;
  superseded_by?: string;
  /** Soft-deletion timestamp. Deleted notes remain in the vault but not the active index. */
  deleted?: string;
}

/** A fully materialized note (frontmatter + body), as read from / written to disk. */
export interface MemoryNote {
  frontmatter: MemoryFrontmatter;
  body: string;
  /** Absolute path on disk. */
  path: string;
}

/** A row in the derived search index. */
export interface IndexRow {
  id: string;
  type: MemoryType;
  scope: string;
  agent: Agent;
  created: string;
  source_session: string;
  title: string;
  tags: string;
  body: string;
  path: string;
}
