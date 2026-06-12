import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../src/config.ts";
import { MemoryIndex } from "../src/vault/index.ts";
import { writeExtraction } from "../src/vault/write.ts";

const repo = join(import.meta.dir, "..");
const base = join(tmpdir(), `wren-mcp-${randomUUID()}`);
const env = {
  ...process.env,
  WREN_CONFIG_DIR: join(base, "cfg"),
  WREN_DATA_DIR: join(base, "data"),
  WREN_LOG_LEVEL: "error",
};

let client: Client;
let transport: StdioClientTransport;

describe("MCP server (stdio, real client)", () => {
  beforeAll(async () => {
    // Seed a memory into the temp vault the server will read.
    for (const [k, v] of Object.entries(env)) if (v) process.env[k] = v as string;
    const cfg = await loadConfig();
    const index = await MemoryIndex.open(cfg.indexDbPath);
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
        ],
      },
      agent: "claude-code",
      sessionId: "seed-1",
      scope: "/home/x/proj",
      nowIso: "2026-06-10T12:00:00.000Z",
    });
    index.close();

    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", join(repo, "src/cli.ts"), "mcp"],
      env: env as Record<string, string>,
      cwd: repo,
    });
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    await rm(base, { recursive: true, force: true });
  });

  it("lists the three tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_memory", "list_recent", "search_memories"]);
  });

  it("search_memories finds the seeded memory", async () => {
    const res = (await client.callTool({
      name: "search_memories",
      arguments: { query: "rename", scope: "all" },
    })) as { content: Array<{ type: string; text: string }> };
    expect(res.content[0]?.text).toContain("atomic rename");
  });

  it("list_recent returns the memory", async () => {
    const res = (await client.callTool({
      name: "list_recent",
      arguments: { scope: "all" },
    })) as { content: Array<{ type: string; text: string }> };
    expect(res.content[0]?.text).toContain("rename");
  });
});
