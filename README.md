# wwv-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes a running WorldWideView instance + its data engine to any MCP-aware AI agent (Claude Code, Claude Desktop, etc.).

## What it lets an agent do today

Seven read-only tools — enough for every "what's happening" query an agent might ask:

| Tool | What it does |
|---|---|
| `camera_list_sources` | Lists every camera adapter registered on the WWV instance with health + key-required state. |
| `camera_get` | Fetches cameras from one or more sources (or all). |
| `camera_near` | Finds cameras within N km of a coordinate, sorted by distance. |
| `camera_view` | Fetches a single camera's full record by id. |
| `plugin_list` | Lists installed plugins (requires session token). |
| `engine_query` | Fetches live data for a given seeder (aviation, wildfires, earthquakes, …). |
| `engine_health` | Reports engine status + last-fetch time per seeder. |

## Eventually: bidirectional UI driving

There's a stub at `src/bus.ts` for the WebSocket channel that will let an agent *drive* the globe — fly to coordinates, focus a camera, toggle layers. Plan documented in that file. Read-only tools work today; the bus implementation is a follow-up once we know which write actions agents actually want.

## Install

```sh
npm install
npm run build
```

(or `npm run dev` for watch-mode TypeScript via tsx)

## Configure

Copy `.env.example` to `.env` and set:

- `WWV_BASE_URL` — your WWV instance, e.g. `https://oracle.internal`
- `WWV_ENGINE_URL` — your data engine, e.g. `http://localhost:5001`
- `WWV_SESSION_TOKEN` *(optional)* — Auth.js session cookie value, only required for `plugin_list`

To grab the session cookie: in the browser, open DevTools → Application → Cookies → `__Secure-authjs.session-token` → copy the value.

### Self-signed certs (mkcert)

If WWV is served over an mkcert-issued cert (the typical local-host setup), point Node at the mkcert root CA so TLS verification succeeds:

```sh
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
```

Add the same to the `env` block in your Claude config if running there. Alternatively, install the mkcert CA system-wide (`mkcert -install`) and Node will pick it up via the OS trust store.

## Wire into Claude Code

Add to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "wwv": {
      "command": "node",
      "args": ["/Users/fox/AI/Projects/wwv-mcp/dist/index.js"],
      "env": {
        "WWV_BASE_URL": "https://oracle.internal",
        "WWV_ENGINE_URL": "http://localhost:5001"
      }
    }
  }
}
```

Then `/mcp` in Claude Code should list `wwv` with all 7 tools available.

## Wire into Claude Desktop

Similar — edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and add the same `mcpServers.wwv` block.

## Architecture

- `src/index.ts` — entry, creates `McpServer`, attaches stdio transport.
- `src/config.ts` — env loading.
- `src/client.ts` — REST wrappers around WWV + engine, with optional session-cookie auth and self-signed-TLS tolerance for mkcert setups.
- `src/tools.ts` — the 7 tools as `(name, schema, handler)` triples plus a `registerAll()` helper. Adding a tool: add an entry, no other changes.
- `src/bus.ts` — placeholder for the future WebSocket bus that will enable UI-driving tools.

## Examples

Once wired into Claude Code, you can ask things like:

- *"What camera sources are available right now?"* → `camera_list_sources`
- *"Find me 10 traffic cameras near downtown Seattle."* → `camera_near` with `lat: 47.6062, lon: -122.3321, limit: 10`
- *"Show me current wildfire data."* → `engine_query` with `plugin: "wildfires"`
- *"What aviation traffic is being tracked?"* → `engine_query` with `plugin: "aviation"`
- *"Are all the data seeders healthy?"* → `engine_health`

## License

MIT (matching upstream WorldWideView).
