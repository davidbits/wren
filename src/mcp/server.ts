/**
 * Local stdio MCP server — the pull-based, deep-recall half of retrieval.
 *
 * Tools:
 *   - search_memories(query, scope?, limit?)  full-text search over learnings
 *   - get_memory(id)                          fetch one note + connection menu
 *   - explore_memory(id, relation, ...)       follow one bounded pathway
 *   - list_recent(scope?, limit?)             recently captured memories
 *   - delete_memory(id)                       delete one non-session note
 *   - delete_session(id)                      delete one session audit note
 *
 * Register for Claude with:
 *   claude mcp add wren --scope user -- bun run <repo>/src/cli.ts mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { enabledScopeFor, loadConfig, loadProjects } from "../config.ts";
import type { IndexRow } from "../types.ts";
import { logger } from "../util/log.ts";
import { type DeleteTarget, softDeleteById } from "../vault/delete.ts";
import { type ExplorationRelation, MemoryIndex, type SearchHit } from "../vault/index.ts";
import { scopesFor } from "../vault/store.ts";

const log = logger("mcp");

function text(s: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: s }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function formatHit(h: SearchHit): string {
  const tags = h.tags ? ` #${h.tags.split(" ").filter(Boolean).join(" #")}` : "";
  return [
    `### ${h.title}`,
    `id: ${h.id} · type: ${h.type} · scope: ${h.scope === "global" ? "global" : "project"}${tags}`,
    h.snippet || h.body.slice(0, 240),
  ].join("\n");
}

interface NextStep {
  tool: string;
  arguments: Record<string, unknown>;
  suggestion: string;
}

function hints(nextSteps: NextStep[] = [], warnings: string[] = []) {
  return { next_steps: nextSteps, related: [], warnings };
}

function resultRecord(row: IndexRow, extra: Record<string, unknown> = {}) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    scope: row.scope,
    tags: row.tags.split(" ").filter(Boolean),
    ...extra,
  };
}

function inspectHints(hits: SearchHit[], scope: string | undefined): NextStep[] {
  return hits.slice(0, 5).map((hit) => ({
    tool: "get_memory",
    arguments: { id: hit.id, ...(scope ? { scope } : {}) },
    suggestion: "Inspect this option and receive its available pathways.",
  }));
}

function inspectMenu(hits: SearchHit[], scope: string | undefined): string {
  const steps = hits
    .slice(0, 5)
    .map(
      (hit) => `- get_memory(id="${hit.id}"${scope ? `, scope="${scope}"` : ""}) — ${hit.title}`,
    );
  return ["Next steps:", ...steps].join("\n");
}

function explorationHints(row: NonNullable<ReturnType<MemoryIndex["get"]>>) {
  const concepts = row.tags.split(" ").filter(Boolean);
  const nextSteps: Array<Record<string, unknown>> = [
    {
      tool: "explore_memory",
      arguments: { id: row.id, relation: "same_session" },
      suggestion: "Follow memories captured in the same session; add query to focus this hop.",
    },
  ];
  if (concepts[0]) {
    nextSteps.push({
      tool: "explore_memory",
      arguments: { id: row.id, relation: "shared_concept", concept: concepts[0] },
      suggestion: `Follow memories sharing #${concepts[0]}; replace concept with another listed tag.`,
    });
  }
  nextSteps.push({
    tool: "explore_memory",
    arguments: { id: row.id, relation: "similar_text" },
    suggestion: "Find lexical neighbors; add query to steer the similarity search.",
  });
  return {
    next_steps: nextSteps,
    optional_arguments: {
      query: "Focus same_session or extend similar_text with additional terms.",
      visited: "Exclude already visited memory IDs to prevent cycles.",
      limit: "Bound returned options from 1 to 20.",
      scope: "Use all or a project path; defaults to current project plus global.",
    },
    related: [],
    warnings: [],
  };
}

function connectionMenu(row: NonNullable<ReturnType<MemoryIndex["get"]>>): string {
  const concepts = row.tags.split(" ").filter(Boolean);
  return [
    "Next steps:",
    `- same_session: explore_memory(id="${row.id}", relation="same_session", query="<optional focus>")`,
    concepts.length
      ? `- shared_concept: explore_memory(id="${row.id}", relation="shared_concept", concept="${concepts[0]}") — available: ${concepts.map((tag) => `#${tag}`).join(" ")}`
      : "- shared_concept: none",
    `- similar_text: explore_memory(id="${row.id}", relation="similar_text", query="<optional focus>")`,
    "Optional controls: visited=[ids], limit=1..20, scope=all|<project path>.",
  ].join("\n");
}

function formatOption(h: SearchHit, sourceId: string, relation: ExplorationRelation): string {
  return `${formatHit(h)}\nvia: ${sourceId} --${relation}--> ${h.id}`;
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

export function createMcpServer(index: MemoryIndex): McpServer {
  const server = new McpServer({ name: "wren", version: "0.1.0" });

  server.registerTool(
    "delete_memory",
    {
      title: "Delete memory",
      description:
        "Soft-delete one non-session memory note by id. The note remains in the vault but is removed from active retrieval.",
      inputSchema: {
        id: z.string().describe("Memory id to delete."),
        scope: z
          .string()
          .optional()
          .describe("'all', or a project path. Defaults to current project + global."),
      },
    },
    async ({ id, scope }) => deleteResponse(index, id, "memory", scope),
  );

  server.registerTool(
    "delete_session",
    {
      title: "Delete session",
      description:
        "Soft-delete one session audit note and every memory extracted from its source session. Notes remain in the vault but are removed from active retrieval.",
      inputSchema: {
        id: z.string().describe("Session note id to delete."),
        scope: z
          .string()
          .optional()
          .describe("'all', or a project path. Defaults to current project + global."),
      },
    },
    async ({ id, scope }) => deleteResponse(index, id, "session", scope),
  );

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
      if (!hits.length) {
        const nextSteps: NextStep[] = [
          {
            tool: "list_recent",
            arguments: { ...(scope ? { scope } : {}) },
            suggestion: "Inspect recent memories when keywords do not match.",
          },
        ];
        if (scope !== "all") {
          nextSteps.push({
            tool: "search_memories",
            arguments: { query, scope: "all", limit: limit ?? 10 },
            suggestion: "Retry across every scope if broader recall is appropriate.",
          });
        }
        return text(`No memories matched "${query}". Try fewer or broader keywords.`, {
          status: "empty",
          summary: `No memories matched "${query}".`,
          results: [],
          _hints: hints(nextSteps, ["Try fewer or broader keywords."]),
        });
      }
      return text(`${hits.map(formatHit).join("\n\n")}\n\n${inspectMenu(hits, scope)}`, {
        status: "ok",
        summary: `Found ${hits.length} memory option(s) for "${query}".`,
        results: hits.map((hit) => resultRecord(hit, { rank: hit.rank, snippet: hit.snippet })),
        _hints: hints(inspectHints(hits, scope)),
      });
    },
  );

  server.registerTool(
    "get_memory",
    {
      title: "Get memory",
      description: "Fetch the full content of one memory note by its id.",
      inputSchema: {
        id: z.string().describe("The memory id (from search results)."),
        scope: z
          .string()
          .optional()
          .describe("'all', or a project path. Defaults to current project + global."),
      },
    },
    async ({ id, scope }) => {
      const scopes = await resolveScopes(scope);
      const row = index.getScoped(id, scopes);
      if (!row) {
        return text(`No memory with id ${id}. Check its id or scope.`, {
          status: "not_found",
          summary: `No memory with id ${id}.`,
          results: [],
          _hints: hints(
            [
              {
                tool: "list_recent",
                arguments: { ...(scope ? { scope } : {}) },
                suggestion: "List available memory IDs in the current scope.",
              },
            ],
            ["The memory may be outside the selected scope or superseded from the active index."],
          ),
        });
      }
      return text(
        `# ${row.title}\n\n${row.body}\n\n_(scope: ${row.scope}, type: ${row.type})_\n\n${connectionMenu(row)}`,
        {
          status: "ok",
          summary: `Loaded memory ${row.id}.`,
          results: [resultRecord(row, { body: row.body })],
          _hints: explorationHints(row),
        },
      );
    },
  );

  server.registerTool(
    "explore_memory",
    {
      title: "Explore memory connections",
      description:
        "Follow one bounded connection from a selected memory. The agent chooses each hop; Wren does not automatically expand a graph.",
      inputSchema: {
        id: z.string().describe("Memory id to explore from."),
        relation: z
          .enum(["same_session", "shared_concept", "similar_text"])
          .describe("Connection to follow."),
        concept: z
          .string()
          .optional()
          .describe("For shared_concept, restrict traversal to one tag shown by get_memory."),
        query: z
          .string()
          .optional()
          .describe("Optional words used to focus same_session or extend similar_text."),
        visited: z
          .array(z.string())
          .max(100)
          .optional()
          .describe("Memory ids already visited; excluded to prevent cycles."),
        scope: z
          .string()
          .optional()
          .describe("'all', or a project path. Defaults to current project + global."),
        limit: z.number().int().min(1).max(20).optional().describe("Max options (default 10)."),
      },
    },
    async ({ id, relation, concept, query, visited, scope, limit }) => {
      const scopes = await resolveScopes(scope);
      const source = index.getScoped(id, scopes);
      if (!source) {
        return text(`No memory with id ${id}. Check its id or scope.`, {
          status: "not_found",
          summary: `Cannot explore missing memory ${id}.`,
          results: [],
          _hints: hints(
            [
              {
                tool: "list_recent",
                arguments: { ...(scope ? { scope } : {}) },
                suggestion: "Choose an available memory to explore.",
              },
            ],
            ["The source memory must be visible in the selected scope."],
          ),
        });
      }
      const hits = index.explore(id, relation, {
        scopes,
        concept,
        query,
        visited,
        limit: limit ?? 10,
      });
      if (!hits.length) {
        return text(`No ${relation} options from ${id}. Choose another pathway or search again.`, {
          status: "empty",
          summary: `No ${relation} options from ${id}.`,
          results: [],
          _hints: hints(
            [
              {
                tool: "get_memory",
                arguments: { id, ...(scope ? { scope } : {}) },
                suggestion: "Review other pathways exposed by this memory.",
              },
              {
                tool: "search_memories",
                arguments: { query: query || source.title, ...(scope ? { scope } : {}) },
                suggestion: "Return to keyword search using this memory as a new seed.",
              },
            ],
            ["This pathway may have no unvisited options in the selected scope."],
          ),
        });
      }
      return text(
        `${hits.map((hit) => formatOption(hit, id, relation)).join("\n\n")}\n\n${inspectMenu(hits, scope)}`,
        {
          status: "ok",
          summary: `Found ${hits.length} ${relation} option(s) from ${id}.`,
          results: hits.map((hit) =>
            resultRecord(hit, {
              rank: hit.rank,
              snippet: hit.snippet,
              via: { source_id: id, relation, target_id: hit.id },
            }),
          ),
          _hints: hints(inspectHints(hits, scope)),
        },
      );
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
      if (!hits.length) {
        const nextSteps: NextStep[] = [];
        if (scope !== "all") {
          nextSteps.push({
            tool: "list_recent",
            arguments: { scope: "all", limit: limit ?? 10 },
            suggestion: "Check other scopes if broader recall is appropriate.",
          });
        }
        return text("No memories captured in this scope yet.", {
          status: "empty",
          summary: "No recent memories found.",
          results: [],
          _hints: hints(nextSteps, ["Capture must complete before new memories appear."]),
        });
      }
      return text(`${hits.map(formatHit).join("\n\n")}\n\n${inspectMenu(hits, scope)}`, {
        status: "ok",
        summary: `Found ${hits.length} recent memory option(s).`,
        results: hits.map((hit) => resultRecord(hit, { rank: hit.rank, snippet: hit.snippet })),
        _hints: hints(inspectHints(hits, scope)),
      });
    },
  );

  return server;
}

async function deleteResponse(
  index: MemoryIndex,
  id: string,
  target: DeleteTarget,
  scope: string | undefined,
) {
  const cfg = await loadConfig();
  const scopes = await resolveScopes(scope);
  const result = await softDeleteById(cfg, index, id, target, { scopes });
  if (result.status === "not_found") {
    return text(`No ${target} with id ${id}.`, {
      status: "not_found",
      summary: `No ${target} with id ${id}.`,
      results: [],
      _hints: hints([], ["Check the id and use the matching delete tool."]),
    });
  }
  if (result.status === "wrong_type") {
    const tool = result.actualType === "session" ? "delete_session" : "delete_memory";
    return text(`ID ${id} is ${result.actualType}, not ${target}. Use ${tool}.`, {
      status: "wrong_type",
      summary: `ID ${id} is ${result.actualType}, not ${target}.`,
      results: [],
      _hints: hints([
        {
          tool,
          arguments: { id },
          suggestion: `Delete this ${result.actualType} with the matching tool.`,
        },
      ]),
    });
  }
  const memoryCount = result.deleted.filter((note) => note.frontmatter.type !== "session").length;
  const suffix = target === "session" ? ` and ${memoryCount} memory(s)` : "";
  return text(`Soft-deleted ${target} ${id}${suffix}.`, {
    status: "deleted",
    summary: `Soft-deleted ${result.deleted.length} note(s).`,
    results: result.deleted.map((note) =>
      resultRecord(MemoryIndex.rowFromNote(note), { deleted: result.deletedAt }),
    ),
    _hints: hints(),
  });
}

export async function runMcpServer(): Promise<void> {
  const cfg = await loadConfig();
  const index = await MemoryIndex.open(cfg.indexDbPath);
  const server = createMcpServer(index);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server connected (stdio)", { vault: cfg.vaultPath });
}
