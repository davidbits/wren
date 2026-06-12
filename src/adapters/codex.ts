/**
 * Codex rollout adapter.
 *
 * Reads `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. Verified schema:
 * JSONL of `{ type, timestamp, payload }`. The first line is
 * `session_meta` (has id + cwd); the bulk are `response_item`s whose inner
 * `payload.type` is `message` / `function_call` / `function_call_output` /
 * `reasoning`. We drop reasoning and the `developer` role (permissions preamble).
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { NormalizedTranscript, NormalizedTurn, ToolCall } from "../types.ts";
import { readLines } from "./lines.ts";

function codexSessionsDir(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
}

/**
 * Fallback used only when a Codex `Stop` payload carries a null `transcript_path`
 * (the documented field is normally present). Discovers the newest rollout whose
 * `session_meta.cwd` matches the project. The scan is bounded to recent files by
 * mtime.
 */
export async function findLatestCodexRollout(
  cwd: string,
): Promise<{ path: string; sessionId: string } | null> {
  const root = codexSessionsDir();
  const glob = new Bun.Glob("**/rollout-*.jsonl");
  const files: Array<{ path: string; mtime: number }> = [];
  try {
    for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
      const path = join(root, rel);
      try {
        files.push({ path, mtime: (await stat(path)).mtimeMs });
      } catch {
        /* ignore */
      }
    }
  } catch {
    return null;
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const target = resolve(cwd);
  for (const { path } of files.slice(0, 50)) {
    for await (const raw of readLines(path)) {
      let line: CodexLine;
      try {
        line = JSON.parse(raw) as CodexLine;
      } catch {
        break;
      }
      if (line.type !== "session_meta") break; // meta is always first
      const metaCwd = line.payload?.cwd ? resolve(line.payload.cwd) : "";
      if (metaCwd && (metaCwd === target || target.startsWith(`${metaCwd}/`))) {
        return { path, sessionId: line.payload?.id ?? "" };
      }
      break;
    }
  }
  return null;
}

const MAX_BLOCK = 2000;

interface CodexContent {
  type?: string;
  text?: string;
}
interface CodexPayload {
  type?: string;
  // session_meta
  id?: string;
  cwd?: string;
  // message
  role?: string;
  content?: CodexContent[] | string;
  // function_call
  name?: string;
  arguments?: string;
  // function_call_output
  output?: unknown;
}
interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: CodexPayload;
}

function clip(s: string): string {
  return s.length > MAX_BLOCK ? `${s.slice(0, MAX_BLOCK)}…[truncated]` : s;
}

function renderContent(content: CodexContent[] | string | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => c.text ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function renderOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const o = output as { output?: string; content?: unknown };
    if (typeof o.output === "string") return o.output;
    if (typeof o.content === "string") return o.content;
    return JSON.stringify(output);
  }
  return "";
}

export async function parseCodexTranscript(path: string): Promise<NormalizedTranscript> {
  const turns: NormalizedTurn[] = [];
  let sessionId = "";
  let cwd = "";
  let startedAt: string | undefined;
  let endedAt: string | undefined;

  for await (const raw of readLines(path)) {
    let line: CodexLine;
    try {
      line = JSON.parse(raw) as CodexLine;
    } catch {
      continue;
    }
    if (line.timestamp) {
      startedAt ??= line.timestamp;
      endedAt = line.timestamp;
    }
    const p = line.payload;
    if (!p) continue;

    if (line.type === "session_meta") {
      if (p.id) sessionId = p.id;
      if (p.cwd) cwd = p.cwd;
      continue;
    }
    if (line.type !== "response_item") continue;

    switch (p.type) {
      case "message": {
        if (p.role === "developer" || p.role === "system") break;
        const text = renderContent(p.content);
        if (text.trim()) {
          turns.push({
            role: p.role === "assistant" ? "assistant" : "user",
            text,
            ts: line.timestamp,
          });
        }
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        if (!p.name) break;
        const call: ToolCall = { name: p.name, input: clip(p.arguments ?? "") };
        turns.push({ role: "assistant", text: "", toolCalls: [call], ts: line.timestamp });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const out = clip(renderOutput(p.output));
        if (out.trim()) turns.push({ role: "tool", text: out, ts: line.timestamp });
        break;
      }
      default:
        break; // reasoning, etc.
    }
  }

  return { agent: "codex", sessionId, cwd, turns, startedAt, endedAt };
}
