/**
 * Derived search index — SQLite FTS5 (D19; embeddings deferred to phase 5).
 *
 * NOT canonical: the markdown vault is the source of truth and this index is
 * fully rebuildable from it (`wren rebuild`). We keep one FTS5 table with
 * the searchable columns tokenized and the metadata columns `UNINDEXED` (stored,
 * returnable, and filterable via plain `WHERE`).
 */
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { IndexRow, MemoryNote } from "../types.ts";

export interface SearchHit extends IndexRow {
  /** bm25 score — lower is a better match. */
  rank: number;
  /** Highlighted/contextual snippet of the body. */
  snippet: string;
}

export type ExplorationRelation = "same_session" | "shared_concept" | "similar_text";

export interface ExploreOptions {
  scopes?: string[];
  limit?: number;
  query?: string;
  concept?: string;
  visited?: string[];
}

export class MemoryIndex {
  private db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static async open(dbPath: string): Promise<MemoryIndex> {
    await mkdir(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED, type UNINDEXED, scope UNINDEXED, agent UNINDEXED,
        created UNINDEXED, source_session UNINDEXED, path UNINDEXED,
        title, body, tags,
        tokenize = 'porter unicode61'
      )
    `);
    return new MemoryIndex(db);
  }

  /** Map a markdown note to an index row. */
  static rowFromNote(note: MemoryNote): IndexRow {
    const fm = note.frontmatter;
    return {
      id: fm.id,
      type: fm.type,
      scope: fm.scope,
      agent: fm.agent,
      created: fm.created,
      source_session: fm.source_session,
      title: fm.title ?? "",
      tags: (fm.tags ?? []).join(" "),
      body: note.body,
      path: note.path,
    };
  }

  /** Insert or replace a row. Identity and path are both unique in the vault. */
  upsert(row: IndexRow): void {
    this.db.query("DELETE FROM memories_fts WHERE id = ? OR path = ?").run(row.id, row.path);
    this.db
      .query(
        `INSERT INTO memories_fts
          (id, type, scope, agent, created, source_session, path, title, body, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.type,
        row.scope,
        row.agent,
        row.created,
        row.source_session,
        row.path,
        row.title,
        row.body,
        row.tags,
      );
  }

  upsertNote(note: MemoryNote): void {
    this.upsert(MemoryIndex.rowFromNote(note));
  }

  remove(id: string): void {
    this.db.query("DELETE FROM memories_fts WHERE id = ?").run(id);
  }

  clear(): void {
    this.db.run("DELETE FROM memories_fts");
  }

  count(): number {
    const r = this.db.query("SELECT COUNT(*) AS n FROM memories_fts").get() as { n: number };
    return r.n;
  }

  get(id: string): IndexRow | null {
    const r = this.db
      .query(
        "SELECT id, type, scope, agent, created, source_session, path, title, body, tags FROM memories_fts WHERE id = ?",
      )
      .get(id) as IndexRow | null;
    return r ?? null;
  }

  /** Fetch a note only when it belongs to one of the allowed scopes. */
  getScoped(id: string, scopes?: string[]): IndexRow | null {
    const row = this.get(id);
    return row && (!scopes?.length || scopes.includes(row.scope)) ? row : null;
  }

  /**
   * Return bounded, agent-selected neighbors. Session membership is a
   * hyperedge, tags are lightweight concepts, and text similarity is computed
   * only when requested. No pairwise graph is materialized.
   */
  explore(id: string, relation: ExplorationRelation, opts: ExploreOptions = {}): SearchHit[] {
    const source = this.getScoped(id, opts.scopes);
    if (!source) return [];

    const limit = opts.limit ?? 10;
    const excluded = new Set([id, ...(opts.visited ?? [])]);
    let candidates: SearchHit[];

    if (relation === "same_session") {
      const match = opts.query ? toMatchExpr(opts.query) : "";
      const params: (string | number)[] = [];
      const clauses: string[] = [];
      if (match) {
        clauses.push("memories_fts MATCH ?");
        params.push(match);
      }
      clauses.push("source_session = ?");
      params.push(source.source_session);
      appendScopeClause(clauses, params, opts.scopes);
      appendExcludedClause(clauses, params, excluded);
      params.push(limit);
      const rank = match ? "bm25(memories_fts)" : "0";
      const snippet = match
        ? "snippet(memories_fts, 8, '«', '»', '…', 12)"
        : "substr(body, 1, 200)";
      return this.db
        .query(
          `SELECT id, type, scope, agent, created, source_session, path, title, body, tags,
                  ${rank} AS rank, ${snippet} AS snippet
           FROM memories_fts
           WHERE ${clauses.join(" AND ")}
           ORDER BY ${match ? "rank" : "created DESC"}
           LIMIT ?`,
        )
        .all(...params) as SearchHit[];
    }

    if (relation === "shared_concept") {
      const sourceTags = source.tags.split(/\s+/).filter(Boolean);
      const concept = opts.concept?.trim().toLowerCase();
      const concepts = concept
        ? sourceTags.filter((tag) => tag.toLowerCase() === concept)
        : sourceTags;
      if (!concepts.length) return [];
      const params: (string | number)[] = [toMatchExpr(concepts.join(" "))];
      const clauses = ["tags MATCH ?"];
      appendScopeClause(clauses, params, opts.scopes);
      appendExcludedClause(clauses, params, excluded);
      params.push(Math.max(limit * 3, 20));
      candidates = this.db
        .query(
          `SELECT id, type, scope, agent, created, source_session, path, title, body, tags,
                  bm25(memories_fts) AS rank,
                  snippet(memories_fts, 8, '«', '»', '…', 12) AS snippet
           FROM memories_fts
           WHERE ${clauses.join(" AND ")}
           ORDER BY rank
           LIMIT ?`,
        )
        .all(...params) as SearchHit[];
      const allowed = new Set(concepts.map((tag) => tag.toLowerCase()));
      return candidates
        .filter(
          (hit) =>
            !excluded.has(hit.id) &&
            hit.tags
              .split(/\s+/)
              .filter(Boolean)
              .some((tag) => allowed.has(tag.toLowerCase())),
        )
        .slice(0, limit);
    }

    const similarityQuery = [source.title, source.tags].filter(Boolean).join(" ");
    if (!similarityQuery) return [];
    return this.search(opts.query ? `${similarityQuery} ${opts.query}` : similarityQuery, {
      scopes: opts.scopes,
      limit: Math.max(limit * 5, 20),
    })
      .filter((hit) => !excluded.has(hit.id))
      .slice(0, limit);
  }

  /**
   * Full-text search, optionally restricted to a set of scopes. Tokens are
   * quoted and OR-joined for recall; results ranked by bm25.
   */
  search(query: string, opts: { scopes?: string[]; limit?: number } = {}): SearchHit[] {
    const limit = opts.limit ?? 10;
    const match = toMatchExpr(query);
    if (!match) return this.recent(opts);

    const params: (string | number)[] = [match];
    let scopeClause = "";
    if (opts.scopes?.length) {
      scopeClause = ` AND scope IN (${opts.scopes.map(() => "?").join(", ")})`;
      params.push(...opts.scopes);
    }
    params.push(limit);

    return this.db
      .query(
        `SELECT id, type, scope, agent, created, source_session, path, title, body, tags,
                bm25(memories_fts) AS rank,
                snippet(memories_fts, 8, '«', '»', '…', 12) AS snippet
         FROM memories_fts
         WHERE memories_fts MATCH ?${scopeClause}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...params) as SearchHit[];
  }

  /** Most recent notes, optionally scoped. */
  recent(opts: { scopes?: string[]; limit?: number } = {}): SearchHit[] {
    const limit = opts.limit ?? 10;
    const params: (string | number)[] = [];
    let scopeClause = "";
    if (opts.scopes?.length) {
      scopeClause = ` WHERE scope IN (${opts.scopes.map(() => "?").join(", ")})`;
      params.push(...opts.scopes);
    }
    params.push(limit);
    return this.db
      .query(
        `SELECT id, type, scope, agent, created, source_session, path, title, body, tags,
                0 AS rank, substr(body, 1, 200) AS snippet
         FROM memories_fts${scopeClause}
         ORDER BY created DESC
         LIMIT ?`,
      )
      .all(...params) as SearchHit[];
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Turn a free-text query into a safe FTS5 MATCH expression. Strips FTS special
 * characters, quotes each remaining token, and OR-joins them. Returns "" when
 * the query has no usable tokens (caller falls back to recency).
 */
export function toMatchExpr(query: string): string {
  const tokens = query
    .toLowerCase()
    .replace(/["()*:^-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (!tokens.length) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

function appendScopeClause(
  clauses: string[],
  params: (string | number)[],
  scopes: string[] | undefined,
): void {
  if (!scopes?.length) return;
  clauses.push(`scope IN (${scopes.map(() => "?").join(", ")})`);
  params.push(...scopes);
}

function appendExcludedClause(
  clauses: string[],
  params: (string | number)[],
  excluded: Set<string>,
): void {
  if (!excluded.size) return;
  clauses.push(`id NOT IN (${[...excluded].map(() => "?").join(", ")})`);
  params.push(...excluded);
}
