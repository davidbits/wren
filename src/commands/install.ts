/**
 * `wren install` — one-command, agent-agnostic setup (code-review-graph
 * style). Creates the config + data dirs, writes a default `config.toml`,
 * registers the MCP server with detected agents, and drops a systemd user unit
 * for the worker daemon. Project capture is then turned on per-project with
 * `wren enable <path>`.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Config, ensureDirs } from "../config.ts";
import { logger } from "../util/log.ts";
import { writeCodexMcp } from "./codex-config.ts";
import { selfCommand, selfCommandString } from "./integration.ts";

const log = logger("install");

export interface InstallOptions {
  codex?: boolean;
  systemd?: boolean;
}

async function writeDefaultConfig(cfg: Config): Promise<boolean> {
  const path = join(cfg.configDir, "config.toml");
  if (await Bun.file(path).exists()) return false;
  const template = `# wren configuration
# Vault is the source of truth (human-browsable, git-able).
vault_path = "${cfg.vaultPath}"

# Optional: cheap model for the extractor (codex exec). Omit to use codex default.
# extractor_model = "gpt-5-codex-mini"

# Optional: path to the codex binary.
# codex_bin = "codex"

# Codex home wren reads transcripts from (default: $CODEX_HOME or ~/.codex).
# Run \`wren codex-home\` to detect and pick one interactively.
# codex_home = "~/.codex"

# Max memories injected at SessionStart (keeps context cheap).
max_inject = ${cfg.maxInject}

# Quiet period (ms) a Codex transcript must be idle before it is extracted.
# Codex's Stop hook fires every turn with no session-end event, so we wait for
# the session to go quiet before extracting once. Default 180000 (3 min).
# settle_ms = ${cfg.settleMs}
`;
  await Bun.write(path, template);
  return true;
}

async function registerClaudeMcp(): Promise<boolean> {
  const which = Bun.spawnSync(["which", "claude"]);
  if (which.exitCode !== 0) return false;
  const proc = Bun.spawnSync([
    "claude",
    "mcp",
    "add",
    "wren",
    "--scope",
    "user",
    "--",
    ...selfCommand(),
    "mcp",
  ]);
  if (proc.exitCode !== 0) {
    log.warn("claude mcp add failed", { stderr: proc.stderr.toString().slice(-500) });
    return false;
  }
  return true;
}

async function writeSystemdUnit(): Promise<string> {
  const dir = join(homedir(), ".config", "systemd", "user");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "wren.service");
  const unit = `[Unit]
Description=wren worker — drains the memory extraction queue
After=default.target

[Service]
Type=simple
ExecStart=${selfCommandString("worker")}
Restart=on-failure
RestartSec=5
Environment=WREN_LOG_LEVEL=info

[Install]
WantedBy=default.target
`;
  await Bun.write(path, unit);
  return path;
}

export async function install(cfg: Config, opts: InstallOptions = {}): Promise<void> {
  await ensureDirs(cfg);
  console.log("wren install\n");

  const wroteConfig = await writeDefaultConfig(cfg);
  console.log(`${wroteConfig ? "✓ wrote" : "•"} config: ${join(cfg.configDir, "config.toml")}`);
  console.log(`✓ vault:  ${cfg.vaultPath}`);
  console.log(`✓ data:   ${cfg.dataDir}`);

  const claudeMcp = await registerClaudeMcp();
  console.log(
    claudeMcp
      ? "✓ registered MCP server with Claude (user scope)"
      : `• Claude MCP not registered — run:\n    claude mcp add wren --scope user -- ${selfCommandString("mcp")}`,
  );

  if (opts.codex) {
    const codex = await writeCodexMcp();
    console.log(`✓ registered MCP server with Codex: ${codex.join(", ")}`);
  }

  const unitPath = await writeSystemdUnit();
  console.log(`✓ systemd unit: ${unitPath}`);
  if (opts.systemd) {
    Bun.spawnSync(["systemctl", "--user", "daemon-reload"]);
    const en = Bun.spawnSync(["systemctl", "--user", "enable", "--now", "wren.service"]);
    console.log(
      en.exitCode === 0
        ? "✓ worker daemon enabled + started"
        : "• could not start daemon — start manually: systemctl --user enable --now wren.service",
    );
  } else {
    console.log(
      "  start the worker daemon with:\n    systemctl --user enable --now wren.service",
    );
  }

  console.log("\nNext: enable a project →  wren enable <path>");
}
