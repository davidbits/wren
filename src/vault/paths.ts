/**
 * Vault layout (D17): per-project subfolders plus a shared `global/` scope.
 *
 *   <vault>/projects/<slug>/learnings/*.md
 *   <vault>/projects/<slug>/sessions/*.md
 *   <vault>/global/learnings/*.md
 *
 * `<slug>` is derived deterministically from the scope path so the same project
 * always maps to the same folder.
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { scopeSlug } from "../util/ids.ts";

/** Root folder for a scope ("global" or an absolute project path). */
export function scopeRoot(cfg: Config, scope: string): string {
  return scope === "global"
    ? join(cfg.vaultPath, "global")
    : join(cfg.vaultPath, "projects", scopeSlug(scope));
}

export function learningsDir(cfg: Config, scope: string): string {
  return join(scopeRoot(cfg, scope), "learnings");
}

export function sessionsDir(cfg: Config, scope: string): string {
  return join(scopeRoot(cfg, scope), "sessions");
}

/** Recursively yield every markdown note path under the vault. */
export async function* walkNotes(root: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkNotes(full);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield full;
    }
  }
}
