/**
 * Markdown note (de)serialization: YAML frontmatter + body.
 *
 * Markdown is the source of truth and may be hand-edited, so we parse with a
 * real YAML parser rather than regex.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { MemoryFrontmatter, MemoryNote } from "../types.ts";

const FENCE = "---";

/** Serialize frontmatter + body into a full markdown document. */
export function serializeNote(frontmatter: MemoryFrontmatter, body: string): string {
  // Drop undefined keys so optional fields don't render as `key: null`.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v !== undefined && v !== null) clean[k] = v;
  }
  const yaml = stringifyYaml(clean).trimEnd();
  return `${FENCE}\n${yaml}\n${FENCE}\n\n${body.trim()}\n`;
}

/** Parse a markdown document back into frontmatter + body. Throws if malformed. */
export function parseNote(content: string, path: string): MemoryNote {
  if (!content.startsWith(FENCE)) {
    throw new Error(`note ${path} missing frontmatter fence`);
  }
  const end = content.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) throw new Error(`note ${path} unterminated frontmatter`);
  const yaml = content.slice(FENCE.length + 1, end);
  const body = content.slice(end + FENCE.length + 1).replace(/^\n+/, "");
  const fm = parseYaml(yaml) as MemoryFrontmatter;
  if (!fm?.id || !fm?.type) throw new Error(`note ${path} missing id/type`);
  fm.tags ??= [];
  return { frontmatter: fm, body, path };
}

/** Read + parse a note from disk, or null if unreadable/malformed. */
export async function readNote(path: string): Promise<MemoryNote | null> {
  try {
    return parseNote(await Bun.file(path).text(), path);
  } catch {
    return null;
  }
}
