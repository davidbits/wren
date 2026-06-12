#!/usr/bin/env bash
#
# Build the wren standalone binary and install it to ~/.local/bin.
# No sudo, no Bun required at runtime — the binary embeds the Bun runtime.
#
# Usage: scripts/install.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
TARGET="${BIN_DIR}/wren"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required to build the binary (https://bun.sh)" >&2
  exit 1
fi

echo "Building wren binary…"
cd "${REPO_ROOT}"
bun run build

echo "Installing → ${TARGET}"
mkdir -p "${BIN_DIR}"
install -m 755 "${REPO_ROOT}/dist/wren" "${TARGET}"

echo "✓ installed: ${TARGET}"

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    echo
    echo "⚠ ${BIN_DIR} is not on your PATH. Add it, e.g.:"
    echo "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
    ;;
esac

echo
echo "Next steps:"
echo "    wren --help"
echo "    wren install            # wire MCP + worker (add --codex / --systemd)"
echo "    wren enable <path>      # opt a project in"
