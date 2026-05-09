#!/usr/bin/env bash
# Wrapper script that fetches WWV credentials from 1Password (via the `op`
# CLI) and execs the MCP server. Configure your MCP-aware client (Claude
# Code, Claude Desktop, etc.) to invoke this script instead of `node` so
# credentials never live in plaintext config files.
#
# One-time setup:
#   1. Install + sign in: `brew install 1password-cli && op signin`
#   2. Create a 1Password item with at least:
#        - title:    WWV
#        - username: <your wwv email>
#        - password: <your wwv password>
#   3. Make this script executable: `chmod +x` this file
#   4. Point Claude Code at it (see README).
#
# Override the item path with WWV_OP_ITEM env var if you named yours
# something else (e.g. "Personal/WWV-Self-Host").

set -euo pipefail

OP_ITEM="${WWV_OP_ITEM:-WWV}"

if ! command -v op >/dev/null 2>&1; then
    echo "[wwv-mcp] 'op' (1Password CLI) not found on PATH" >&2
    echo "    install: brew install 1password-cli  (then 'op signin')" >&2
    exit 1
fi

# `op read` resolves a single field by reference. Two reads is fine — they're
# fast and the script runs once per MCP-server lifetime.
WWV_USERNAME="$(op read "op://Personal/${OP_ITEM}/username" 2>/dev/null \
    || op read "op://Private/${OP_ITEM}/username")"
WWV_PASSWORD="$(op read "op://Personal/${OP_ITEM}/password" 2>/dev/null \
    || op read "op://Private/${OP_ITEM}/password")"

export WWV_USERNAME WWV_PASSWORD

# Hand off to the MCP server. exec ensures stdio is wired straight through.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/../dist/index.js"
