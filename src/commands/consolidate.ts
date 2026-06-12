/**
 * Periodic consolidation sweep (D9b) — the backstop against vault rot.
 *
 * v1 is deterministic: within each scope it clusters near-duplicate learnings by
 * title/word similarity and collapses each cluster to its most recent member,
 * marking the rest `superseded_by` it (kept on disk for audit, dropped from the
 * index). LLM-merge of cluster *content* is a future enhancement; pruning
 * near-dupes already keeps the RAG signal clean.
 */
import type { Config } from "../config.ts";
import type { MemoryNote } from "../types.ts";
import { logger } from "../util/log.ts";
import { MemoryIndex } from "../vault/index.ts";
import { serializeNote } from "../vault/note.ts";
import { readAllNotes } from "../vault/store.ts";

const log = logger("consolidate");
const SIMILARITY_THRESHOLD = 0.6;

export interface ConsolidateStats {
  clusters: number;
  pruned: number;
  dryRun: boolean;
}

function wordSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Signature of a learning for similarity = title + first body line. */
function signature(note: MemoryNote): Set<string> {
  const firstLine = note.body.split("\n").find((l) => l.trim()) ?? "";
  return wordSet(`${note.frontmatter.title} ${firstLine}`);
}

/** Greedy single-link clustering of similar notes. */
function cluster(notes: MemoryNote[]): MemoryNote[][] {
  const sigs = notes.map(signature);
  const used = new Array(notes.length).fill(false);
  const clusters: MemoryNote[][] = [];
  for (let i = 0; i < notes.length; i++) {
    if (used[i]) continue;
    const group = [notes[i]!];
    used[i] = true;
    for (let j = i + 1; j < notes.length; j++) {
      if (used[j]) continue;
      if (jaccard(sigs[i]!, sigs[j]!) >= SIMILARITY_THRESHOLD) {
        group.push(notes[j]!);
        used[j] = true;
      }
    }
    clusters.push(group);
  }
  return clusters;
}

export async function consolidate(
  cfg: Config,
  opts: { dryRun?: boolean } = {},
): Promise<ConsolidateStats> {
  const dryRun = opts.dryRun ?? false;
  const all = (await readAllNotes(cfg)).filter(
    (n) => n.frontmatter.type !== "session" && !n.frontmatter.superseded_by,
  );

  // Group by scope so we never merge across projects.
  const byScope = new Map<string, MemoryNote[]>();
  for (const note of all) {
    const arr = byScope.get(note.frontmatter.scope) ?? [];
    arr.push(note);
    byScope.set(note.frontmatter.scope, arr);
  }

  const index = dryRun ? null : await MemoryIndex.open(cfg.indexDbPath);
  let clusters = 0;
  let pruned = 0;
  try {
    for (const notes of byScope.values()) {
      for (const group of cluster(notes)) {
        if (group.length < 2) continue;
        clusters++;
        // Canonical = most recently created.
        group.sort((a, b) => b.frontmatter.created.localeCompare(a.frontmatter.created));
        const [canonical, ...dupes] = group;
        log.info("cluster", {
          scope: canonical!.frontmatter.scope,
          keep: canonical!.frontmatter.title,
          prune: dupes.map((d) => d.frontmatter.title),
        });
        for (const dupe of dupes) {
          pruned++;
          if (dryRun || !index) continue;
          dupe.frontmatter.superseded_by = canonical!.frontmatter.id;
          await Bun.write(dupe.path, serializeNote(dupe.frontmatter, dupe.body));
          index.remove(dupe.frontmatter.id);
        }
      }
    }
  } finally {
    index?.close();
  }

  log.info("consolidation complete", { clusters, pruned, dryRun });
  return { clusters, pruned, dryRun };
}
