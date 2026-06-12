/**
 * Claude Code transcript adapter.
 *
 * Reads `~/.claude/projects/<slug>/<uuid>.jsonl`. Verified schema:
 * JSONL where message lines have `type: "assistant" | "user"` and carry a
 * `message` object with Anthropic content blocks, plus top-level `sessionId`,
 * `cwd`, `timestamp`, `isMeta`. We keep only real conversation, dropping
 * `thinking` blocks and `isMeta` noise (local-command caveats, reminders).
 */

import type { NormalizedTranscript, NormalizedTurn, ToolCall } from "../types.ts";
import { readLines } from "./lines.ts";

const MAX_BLOCK = 2000;

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown; // tool_result content
}

interface ClaudeLine {
  type?: string;
  isMeta?: boolean;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  message?: { role?: string; content?: string | ContentBlock[] };
}

function clip(s: string): string {
  return s.length > MAX_BLOCK ? `${s.slice(0, MAX_BLOCK)}…[truncated]` : s;
}

function renderToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : ((b as ContentBlock)?.text ?? "")))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export async function parseClaudeTranscript(path: string): Promise<NormalizedTranscript> {
  const turns: NormalizedTurn[] = [];
  let sessionId = "";
  let cwd = "";
  let startedAt: string | undefined;
  let endedAt: string | undefined;

  for await (const raw of readLines(path)) {
    let line: ClaudeLine;
    try {
      line = JSON.parse(raw) as ClaudeLine;
    } catch {
      continue;
    }
    if (line.sessionId) sessionId = line.sessionId;
    if (line.cwd) cwd = line.cwd;
    if (line.timestamp) {
      startedAt ??= line.timestamp;
      endedAt = line.timestamp;
    }

    if (line.type !== "assistant" && line.type !== "user") continue;
    if (line.isMeta) continue;
    const content = line.message?.content;
    if (content === undefined) continue;

    if (line.type === "assistant") {
      const texts: string[] = [];
      const toolCalls: ToolCall[] = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) texts.push(block.text);
          else if (block.type === "tool_use" && block.name) {
            toolCalls.push({ name: block.name, input: clip(JSON.stringify(block.input ?? {})) });
          }
        }
      } else if (typeof content === "string") {
        texts.push(content);
      }
      if (texts.length || toolCalls.length) {
        turns.push({
          role: "assistant",
          text: texts.join("\n"),
          toolCalls: toolCalls.length ? toolCalls : undefined,
          ts: line.timestamp,
        });
      }
    } else {
      // user
      if (typeof content === "string") {
        turns.push({ role: "user", text: content, ts: line.timestamp });
      } else if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content) {
          if (block.type === "text" && block.text) texts.push(block.text);
          else if (block.type === "tool_result") {
            turns.push({
              role: "tool",
              text: clip(renderToolResult(block.content)),
              ts: line.timestamp,
            });
          }
        }
        if (texts.length) turns.push({ role: "user", text: texts.join("\n"), ts: line.timestamp });
      }
    }
  }

  return { agent: "claude-code", sessionId, cwd, turns, startedAt, endedAt };
}
