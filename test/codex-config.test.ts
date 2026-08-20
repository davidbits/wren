import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { writeCodexConfig, writeCodexMcp } from "../src/commands/codex-config.ts";

const MEMORY_COMMAND = "echo 'Use wren mcp server to retrieve memories and learnings from Vault.'";

describe("Codex config writer", () => {
  let oldCodexHome: string | undefined;
  let codexHome: string;

  beforeEach(() => {
    oldCodexHome = process.env.CODEX_HOME;
    codexHome = join(tmpdir(), `wren-codex-${randomUUID()}`);
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(async () => {
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    await rm(codexHome, { recursive: true, force: true });
  });

  it("wires Codex MCP and SessionStart memory reminder on install", async () => {
    const changes = await writeCodexMcp();

    expect(changes).toContain("mcp_servers.wren");
    expect(changes).toContain("features.memories=false (native memory off)");
    expect(changes).toContain("SessionStart hook (global hooks.json)");

    const cfg = parse(await Bun.file(join(codexHome, "config.toml")).text()) as {
      features?: { memories?: boolean };
      mcp_servers?: Record<string, unknown>;
    };
    expect(cfg.features?.memories).toBe(false);
    expect(cfg.mcp_servers?.wren).toBeTruthy();

    const hooks = (await Bun.file(join(codexHome, "hooks.json")).json()) as {
      hooks?: {
        SessionStart?: Array<{
          matcher?: string;
          hooks: Array<{ type: string; command: string; timeout?: number; statusMessage?: string }>;
        }>;
      };
    };
    expect(hooks.hooks?.SessionStart).toEqual([
      {
        matcher: "startup|resume",
        hooks: [
          {
            type: "command",
            command: MEMORY_COMMAND,
            timeout: 5,
            statusMessage: "Loading wren memory",
          },
        ],
      },
    ]);
  });

  it("preserves existing Codex hooks and does not duplicate the reminder", async () => {
    await mkdir(codexHome, { recursive: true });
    await Bun.write(
      join(codexHome, "hooks.json"),
      `${JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              {
                matcher: "Write|Edit|Bash",
                hooks: [{ type: "command", command: "echo existing", timeout: 1 }],
              },
            ],
            SessionStart: [
              {
                matcher: "startup|resume",
                hooks: [{ type: "command", command: "echo boot", timeout: 1 }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    await writeCodexMcp();
    await writeCodexMcp();

    const hooks = (await Bun.file(join(codexHome, "hooks.json")).json()) as {
      hooks?: {
        PostToolUse?: Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
        SessionStart?: Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
      };
    };
    expect(hooks.hooks?.PostToolUse?.[0]?.hooks[0]?.command).toBe("echo existing");
    const commands = hooks.hooks?.SessionStart?.[0]?.hooks.map((h) => h.command) ?? [];
    expect(commands).toContain("echo boot");
    expect(commands.filter((command) => command === MEMORY_COMMAND)).toHaveLength(1);
  });

  it("writes project-local Stop and SessionStart hooks on enable", async () => {
    const project = join(codexHome, "project");
    await mkdir(project, { recursive: true });

    const changes = await writeCodexConfig(project);

    expect(changes).toContain(`project trust (${codexHome})`);
    expect(changes).toContain("Stop hook (hooks.json)");
    expect(changes).toContain("SessionStart hook (hooks.json)");

    const hooks = (await Bun.file(join(project, ".codex", "hooks.json")).json()) as {
      hooks?: {
        Stop?: Array<{ hooks: Array<{ command: string; timeout?: number }> }>;
        SessionStart?: Array<{
          matcher?: string;
          hooks: Array<{
            type: string;
            command: string;
            timeout?: number;
            statusMessage?: string;
          }>;
        }>;
      };
    };
    expect(hooks.hooks?.Stop?.[0]?.hooks[0]?.command).toContain("hook codex-capture");
    expect(hooks.hooks?.Stop?.[0]?.hooks[0]?.timeout).toBe(30);
    expect(hooks.hooks?.SessionStart).toEqual([
      {
        matcher: "startup|resume",
        hooks: [
          {
            type: "command",
            command: MEMORY_COMMAND,
            timeout: 5,
            statusMessage: "Loading wren memory",
          },
        ],
      },
    ]);
  });

  it("writes project trust to multiple Codex homes", async () => {
    const secondHome = join(tmpdir(), `wren-codex-${randomUUID()}`);
    const project = join(codexHome, "multi-home-project");
    await mkdir(project, { recursive: true });

    try {
      const changes = await writeCodexConfig(project, [codexHome, secondHome]);

      expect(changes).toContain(`project trust (${codexHome})`);
      expect(changes).toContain(`project trust (${secondHome})`);
      for (const home of [codexHome, secondHome]) {
        const config = parse(await Bun.file(join(home, "config.toml")).text()) as {
          projects?: Record<string, { trust_level?: string }>;
        };
        expect(config.projects?.[project]?.trust_level).toBe("trusted");
      }
    } finally {
      await rm(secondHome, { recursive: true, force: true });
    }
  });
});
