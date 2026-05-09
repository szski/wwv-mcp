#!/usr/bin/env node
/**
 * wwv-mcp — Model Context Protocol server for WorldWideView.
 *
 * Talks to a running WWV instance + its data engine via REST, exposes the
 * surface as MCP tools that any agent (Claude Code, Claude Desktop, the
 * Anthropic API with tool use, etc.) can call.
 *
 * Transport: stdio. Configure your MCP-aware client to launch:
 *   { "command": "node", "args": ["/path/to/wwv-mcp/dist/index.js"] }
 * with WWV_BASE_URL + WWV_ENGINE_URL set in env.
 *
 * Future direction: a WebSocket bus client (see bus.ts) lets the agent
 * drive the running browser globe — fly to a location, focus a camera,
 * etc. Read-only tools land here; write/UI-driving tools go in once the
 * channel exists.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAll } from "./tools.js";
import { tryAutoLogin } from "./auth.js";

async function main() {
    // Auto-login if WWV_USERNAME + WWV_PASSWORD are set, before tools start.
    // Failure is logged but non-fatal — the user can still call auth_login
    // at runtime, or set WWV_SESSION_TOKEN.
    await tryAutoLogin();

    const server = new McpServer({
        name: "wwv-mcp",
        version: "0.2.0",
    });

    registerAll(server);

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    // MCP servers must never write to stdout (it's the protocol channel).
    // Errors go to stderr where the host runtime can surface them.
    console.error("[wwv-mcp] fatal:", err);
    process.exit(1);
});
