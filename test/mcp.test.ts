import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { MemoryIndex } from "../src/vault/index.ts";
import { writeExtraction } from "../src/vault/write.ts";

const base = join(tmpdir(), `wren-mcp-${randomUUID()}`);
const env = {
  ...process.env,
  WREN_CONFIG_DIR: join(base, "cfg"),
  WREN_DATA_DIR: join(base, "data"),
  WREN_LOG_LEVEL: "error",
};

let client: Client;
let index: MemoryIndex;
let server: ReturnType<typeof createMcpServer>;
let seedId: string;

interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  structuredContent?: {
    status?: string;
    summary?: string;
    results?: Array<Record<string, unknown>>;
    _hints?: {
      next_steps?: Array<{ tool: string; arguments: Record<string, unknown> }>;
      optional_arguments?: Record<string, string>;
      warnings?: string[];
    };
  };
}

describe("MCP server (real client)", () => {
  beforeAll(async () => {
    // Seed a memory into the temp vault the server will read.
    for (const [k, v] of Object.entries(env)) if (v) process.env[k] = v as string;
    const cfg = await loadConfig();
    index = await MemoryIndex.open(cfg.indexDbPath);
    await writeExtraction(cfg, index, {
      result: {
        durable: true,
        learnings: [
          {
            type: "learning",
            scope: "/home/x/proj",
            title: "Prefer atomic rename for queue writes",
            text: "Write temp then rename to avoid partial files.",
            why: "Crash safety.",
            how_to_apply: "rename(tmp, dest).",
            tags: ["queue"],
          },
          {
            type: "decision",
            scope: "/home/x/proj",
            title: "Clean abandoned queue temp files",
            text: "Remove stale temp files before processing the queue.",
            why: "Recovery safety.",
            how_to_apply: "Scan temp files when the worker starts.",
            tags: ["recovery"],
          },
        ],
      },
      agent: "claude-code",
      sessionId: "seed-1",
      scope: "/home/x/proj",
      nowIso: "2026-06-10T12:00:00.000Z",
    });
    await writeExtraction(cfg, index, {
      result: {
        durable: true,
        learnings: [
          {
            type: "learning",
            scope: "/home/x/proj",
            title: "Serialize queue consumers",
            text: "Use one queue consumer per data directory.",
            why: "Avoid races.",
            how_to_apply: "Acquire a worker lock.",
            tags: ["queue"],
          },
        ],
      },
      agent: "claude-code",
      sessionId: "seed-2",
      scope: "/home/x/proj",
      nowIso: "2026-06-10T12:01:00.000Z",
    });
    seedId = index.search("atomic rename", { scopes: ["/home/x/proj"] })[0]!.id;
    server = createMcpServer(index);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
    index?.close();
    await rm(base, { recursive: true, force: true });
  });

  it("lists the four tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["explore_memory", "get_memory", "list_recent", "search_memories"]);
  });

  it("search_memories finds the seeded memory", async () => {
    const res = (await client.callTool({
      name: "search_memories",
      arguments: { query: "rename", scope: "all" },
    })) as ToolResponse;
    expect(res.content[0]?.text).toContain("atomic rename");
    expect(res.content[0]?.text).toContain("Next steps:");
    expect(res.structuredContent?.status).toBe("ok");
    expect(res.structuredContent?.results?.[0]?.id).toBe(seedId);
    expect(res.structuredContent?._hints?.next_steps?.[0]?.tool).toBe("get_memory");
  });

  it("list_recent returns the memory", async () => {
    const res = (await client.callTool({
      name: "list_recent",
      arguments: { scope: "all" },
    })) as ToolResponse;
    expect(res.content[0]?.text).toContain("rename");
    expect(res.content[0]?.text).toContain("Next steps:");
    expect(res.structuredContent?.status).toBe("ok");
    expect(res.structuredContent?._hints?.next_steps?.[0]?.tool).toBe("get_memory");
  });

  it("get_memory presents agent-selectable pathways", async () => {
    const res = (await client.callTool({
      name: "get_memory",
      arguments: { id: seedId, scope: "all" },
    })) as ToolResponse;
    expect(res.content[0]?.text).toContain("same_session");
    expect(res.content[0]?.text).toContain('concept="queue"');
    expect(res.content[0]?.text).toContain("similar_text");
    expect(res.content[0]?.text).toContain('query="<optional focus>"');
    expect(res.structuredContent?._hints?.optional_arguments?.query).toContain("Focus");
    expect(res.structuredContent?._hints?.next_steps?.[0]?.tool).toBe("explore_memory");
  });

  it("explore_memory follows one relation and reports its path", async () => {
    const session = (await client.callTool({
      name: "explore_memory",
      arguments: { id: seedId, relation: "same_session", scope: "all" },
    })) as ToolResponse;
    expect(session.content[0]?.text).toContain("abandoned queue temp files");
    expect(session.content[0]?.text).toContain(`via: ${seedId} --same_session-->`);
    expect(session.structuredContent?._hints?.next_steps?.[0]?.tool).toBe("get_memory");

    const concept = (await client.callTool({
      name: "explore_memory",
      arguments: {
        id: seedId,
        relation: "shared_concept",
        concept: "queue",
        scope: "all",
      },
    })) as { content: Array<{ type: string; text: string }> };
    expect(concept.content[0]?.text).toContain("Serialize queue consumers");
  });

  it("returns actionable recovery hints for empty and missing results", async () => {
    const search = (await client.callTool({
      name: "search_memories",
      arguments: { query: "zzzz-no-match", scope: "/home/x/proj" },
    })) as ToolResponse;
    expect(search.structuredContent?.status).toBe("empty");
    expect(search.structuredContent?._hints?.next_steps?.map((step) => step.tool)).toEqual([
      "list_recent",
      "search_memories",
    ]);

    const missing = (await client.callTool({
      name: "get_memory",
      arguments: { id: "missing", scope: "all" },
    })) as ToolResponse;
    expect(missing.structuredContent?.status).toBe("not_found");
    expect(missing.structuredContent?._hints?.warnings?.length).toBeGreaterThan(0);

    const explored = (await client.callTool({
      name: "explore_memory",
      arguments: {
        id: seedId,
        relation: "shared_concept",
        concept: "not-a-source-concept",
        scope: "all",
      },
    })) as ToolResponse;
    expect(explored.structuredContent?.status).toBe("empty");
    expect(explored.structuredContent?._hints?.next_steps?.map((step) => step.tool)).toEqual([
      "get_memory",
      "search_memories",
    ]);

    const recent = (await client.callTool({
      name: "list_recent",
      arguments: { scope: "/empty/project" },
    })) as ToolResponse;
    expect(recent.structuredContent?.status).toBe("empty");
    expect(recent.structuredContent?._hints?.next_steps?.[0]?.arguments.scope).toBe("all");
  });
});
