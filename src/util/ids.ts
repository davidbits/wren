/** Id / slug helpers shared by the vault writer and index. */
import { basename } from "node:path";
import { ulid } from "ulid";

export { ulid };

/** Lowercase, hyphenated, filesystem-safe slug derived from arbitrary text. */
export function slugify(text: string, maxLen = 60): string {
  const s = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, maxLen) || "untitled";
}

/**
 * Stable folder name for a project scope. "global" stays "global"; otherwise we
 * use the directory basename plus a short hash of the full path so two projects
 * with the same basename never collide.
 */
export function scopeSlug(scope: string): string {
  if (scope === "global") return "global";
  const base = slugify(basename(scope), 40);
  const hash = shortHash(scope);
  return `${base}-${hash}`;
}

/** Short deterministic hash (8 hex chars) of a string. */
export function shortHash(input: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(input);
  return h.digest("hex").slice(0, 8);
}

/** `YYYY-MM-DD` in local time, for human-friendly session filenames. */
export function dateStamp(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
