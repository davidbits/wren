/**
 * Vault writer: turn an {@link ExtractionResult} into markdown notes.
 *
 * Writes one session note (audit) plus zero-or-more atomic learning notes (RAG),
 * cross-linked with `[[wikilinks]]`. Handles write-time dedup (D9a): the
 * extractor is shown existing learnings and may echo an `id` to update one or set
 * `supersedes` to replace one. Everything is secret-scrubbed before it touches
 * disk.
 */
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Config } from "../config.ts";
import type {
  Agent,
  AtomicLearning,
  ExtractionResult,
  MemoryFrontmatter,
  MemoryNote,
} from "../types.ts";
import { dateStamp, shortHash, slugify, ulid } from "../util/ids.ts";
import { scrub } from "../util/secrets.ts";
import type { MemoryIndex } from "./index.ts";
import { readNote, serializeNote } from "./note.ts";
import { learningsDir, sessionsDir } from "./paths.ts";
import { readLearnings } from "./store.ts";

export interface WriteParams {
  result: ExtractionResult;
  agent: Agent;
  sessionId: string;
  /** The opt-in project root this session ran in. */
  scope: string;
  nowIso: string;
}

export interface WriteSummary {
  written: boolean;
  sessionNotePath?: string;
  learningPaths: string[];
}

function stem(path: string): string {
  return basename(path).replace(/\.md$/, "");
}

/** Only "global" or the session's own project scope are allowed targets. */
function normalizeScope(scope: string | undefined, projectScope: string): string {
  return scope === "global" ? "global" : projectScope;
}

export async function writeExtraction(
  cfg: Config,
  index: MemoryIndex,
  params: WriteParams,
): Promise<WriteSummary> {
  const { result, agent, sessionId, scope, nowIso } = params;
  if (!result.durable) return { written: false, learningPaths: [] };

  // Existing learnings for dedup/supersede resolution.
  const existing = new Map<string, MemoryNote>();
  for (const note of await readLearnings(cfg, ["global", scope])) {
    existing.set(note.frontmatter.id, note);
  }

  // Pre-generate the session note identity so learnings can link to it.
  const hasSession = !!result.session;
  const sessionStem = `session-${shortHash(sessionId || "nosess", 16)}`;
  const sessionPath = join(sessionsDir(cfg, scope), `${sessionStem}.md`);

  const learningPaths: string[] = [];
  const learningStems: string[] = [];

  for (const learning of result.learnings) {
    const out = await writeLearning(cfg, index, {
      learning,
      agent,
      sessionId,
      projectScope: scope,
      nowIso,
      existing,
      sessionLink: hasSession ? sessionStem : undefined,
    });
    learningPaths.push(out.path);
    learningStems.push(stem(out.path));
  }

  if (hasSession && result.session) {
    await writeSessionNote(cfg, index, {
      session: result.session,
      agent,
      sessionId,
      scope,
      nowIso,
      path: sessionPath,
      learningStems,
    });
  }

  return {
    written: true,
    sessionNotePath: hasSession ? sessionPath : undefined,
    learningPaths,
  };
}

async function writeLearning(
  cfg: Config,
  index: MemoryIndex,
  args: {
    learning: AtomicLearning;
    agent: Agent;
    sessionId: string;
    projectScope: string;
    nowIso: string;
    existing: Map<string, MemoryNote>;
    sessionLink?: string;
  },
): Promise<{ path: string; id: string }> {
  const { learning, agent, sessionId, projectScope, nowIso, existing, sessionLink } = args;
  const scope = normalizeScope(learning.scope, projectScope);

  // Resolve identity: update-in-place if the extractor echoed a known id.
  const updating = learning.id ? existing.get(learning.id) : undefined;
  const id = updating?.frontmatter.id ?? ulid();
  const created = updating?.frontmatter.created ?? nowIso;
  const dir = learningsDir(cfg, scope);
  await mkdir(dir, { recursive: true });
  const path = updating?.path ?? join(dir, `${slugify(learning.title, 50)}-${id.slice(-6)}.md`);

  // Supersede: mark the prior note and drop it from the index.
  let supersedes: string | undefined;
  if (learning.supersedes && existing.has(learning.supersedes)) {
    const old = existing.get(learning.supersedes);
    if (old && old.frontmatter.id !== id) {
      supersedes = old.frontmatter.id;
      old.frontmatter.superseded_by = id;
      await Bun.write(old.path, serializeNote(old.frontmatter, old.body));
      index.remove(old.frontmatter.id);
    }
  }

  const frontmatter: MemoryFrontmatter = {
    id,
    type: learning.type,
    scope,
    agent,
    created,
    source_session: sessionId,
    title: scrub(learning.title),
    tags: learning.tags ?? [],
    ...(supersedes ? { supersedes } : {}),
  };

  const related = sessionLink ? `\n\nRelated: [[${sessionLink}]]` : "";
  const body =
    `${scrub(learning.text).trim()}\n\n` +
    `**Why:** ${scrub(learning.why).trim()}\n` +
    `**How to apply:** ${scrub(learning.how_to_apply).trim()}${related}`;

  await Bun.write(path, serializeNote(frontmatter, body));
  index.upsertNote({ frontmatter, body, path });
  return { path, id };
}

async function writeSessionNote(
  cfg: Config,
  index: MemoryIndex,
  args: {
    session: NonNullable<ExtractionResult["session"]>;
    agent: Agent;
    sessionId: string;
    scope: string;
    nowIso: string;
    path: string;
    learningStems: string[];
  },
): Promise<void> {
  const { session, agent, sessionId, scope, nowIso, path, learningStems } = args;
  await mkdir(sessionsDir(cfg, scope), { recursive: true });

  const previous = await readNote(path);
  if (previous && previous.frontmatter.source_session !== sessionId) {
    throw new Error(`session path collision at ${path}`);
  }
  const id = previous?.frontmatter.id ?? ulid();
  const created = previous?.frontmatter.created ?? nowIso;
  const title = `Session ${dateStamp(created)} — ${slugify(session.objective, 40)}`;
  const frontmatter: MemoryFrontmatter = {
    id,
    type: "session",
    scope,
    agent,
    created,
    source_session: sessionId,
    title: scrub(title),
    tags: session.tags ?? [],
  };

  const files = session.files_touched?.length
    ? session.files_touched.map((f) => `- \`${f}\``).join("\n")
    : "_none_";
  const cmds = session.commands?.length
    ? session.commands.map((c) => `- \`${scrub(c)}\``).join("\n")
    : "_none_";
  const links = learningStems.length
    ? `\n\nLearnings: ${learningStems.map((s) => `[[${s}]]`).join(" ")}`
    : "";

  const body =
    `**Objective:** ${scrub(session.objective).trim()}\n\n` +
    `**Outcome:** ${scrub(session.outcome).trim()}\n\n` +
    `**Files touched:**\n${files}\n\n` +
    `**Commands:**\n${cmds}${links}`;

  await Bun.write(path, serializeNote(frontmatter, body));
  index.upsertNote({ frontmatter, body, path });
}
