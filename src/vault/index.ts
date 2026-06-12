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

  /** Insert or replace a row (FTS5 has no upsert, so delete-then-insert by id). */
  upsert(row: IndexRow): void {
    this.remove(row.id);
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
