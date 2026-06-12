/**
 * Local stdio MCP server — the pull-based, deep-recall half of retrieval.
 *
 * Tools:
 *   - search_memories(query, scope?, limit?)  full-text search over learnings
 *   - get_memory(id)                          fetch one note in full
 *   - list_recent(scope?, limit?)             recently captured memories
 *
 * Register for Claude with:
 *   claude mcp add wren --scope user -- bun run <repo>/src/cli.ts mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { enabledScopeFor, loadConfig, loadProjects } from "../config.ts";
import { logger } from "../util/log.ts";
import { MemoryIndex, type SearchHit } from "../vault/index.ts";
import { scopesFor } from "../vault/store.ts";

const log = logger("mcp");

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function formatHit(h: SearchHit): string {
  const tags = h.tags ? ` #${h.tags.split(" ").filter(Boolean).join(" #")}` : "";
  return [
    `### ${h.title}`,
    `id: ${h.id} · type: ${h.type} · scope: ${h.scope === "global" ? "global" : "project"}${tags}`,
    h.snippet || h.body.slice(0, 240),
  ].join("\n");
}

/**
 * Resolve the scope filter for a tool call. `"all"` searches everything;
 * an explicit path scopes to that project + global; omitted derives from the
 * server's cwd (set when registered per-project).
 */
async function resolveScopes(scopeArg: string | undefined): Promise<string[] | undefined> {
  if (scopeArg === "all") return undefined;
  if (scopeArg) return scopesFor(scopeArg);
  const cfg = await loadConfig();
  const reg = await loadProjects(cfg);
  const scope = enabledScopeFor(process.cwd(), reg);
  return scope ? scopesFor(scope) : undefined;
}

export async function runMcpServer(): Promise<void> {
  const cfg = await loadConfig();
  const index = await MemoryIndex.open(cfg.indexDbPath);

  const server = new McpServer({ name: "wren", version: "0.1.0" });

  server.registerTool(
    "search_memories",
    {
      title: "Search memories",
      description:
        "Full-text search durable learnings captured from past agent sessions. Use to recall fixes, decisions, conventions, and user preferences before redoing work.",
      inputSchema: {
        query: z.string().describe("Keywords to search for."),
        scope: z
          .string()
          .optional()
          .describe(
            "'all' for every project, or a project path. Defaults to the current project + global.",
          ),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
      },
    },
    async ({ query, scope, limit }) => {
      const scopes = await resolveScopes(scope);
      const hits = index.search(query, { scopes, limit: limit ?? 10 });
      if (!hits.length) return text(`No memories matched "${query}".`);
      return text(hits.map(formatHit).join("\n\n"));
    },
  );

  server.registerTool(
    "get_memory",
    {
      title: "Get memory",
      description: "Fetch the full content of one memory note by its id.",
      inputSchema: { id: z.string().describe("The memory id (from search results).") },
    },
    async ({ id }) => {
      const row = index.get(id);
      if (!row) return text(`No memory with id ${id}.`);
      return text(`# ${row.title}\n\n${row.body}\n\n_(scope: ${row.scope}, type: ${row.type})_`);
    },
  );

  server.registerTool(
    "list_recent",
    {
      title: "List recent memories",
      description: "List the most recently captured memories, optionally scoped to a project.",
      inputSchema: {
        scope: z
          .string()
          .optional()
          .describe("'all', or a project path. Defaults to current project + global."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
      },
    },
    async ({ scope, limit }) => {
      const scopes = await resolveScopes(scope);
      const hits = index.recent({ scopes, limit: limit ?? 10 });
      if (!hits.length) return text("No memories captured yet.");
      return text(hits.map(formatHit).join("\n\n"));
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server connected (stdio)", { vault: cfg.vaultPath });
}
