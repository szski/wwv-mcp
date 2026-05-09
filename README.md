# wwv-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes a running WorldWideView instance + its data engine to any MCP-aware AI agent (Claude Code, Claude Desktop, Cursor, Continue, Cline, …).

The agent can both **read** ("what wildfires are near Charlotte right now?") and **drive** ("fly the globe there and toggle the wildfire layer on") the open browser session.

## Tools (15 total)

### System (2)

| Tool | What it does |
|---|---|
| `auth_login` | Authenticate by email + password; cache session in memory. Run once per server lifetime. |
| `system_status` | One-shot health probe: WWV reachable, engine reachable, agent bus enabled, subscriber count, auth state. |

### Read (8)

| Tool | What it does |
|---|---|
| `camera_list_sources` | All registered camera adapters with health + key-required state. |
| `camera_get` | Cameras from one or more sources (or all). |
| `camera_near` | Cameras within N km of a coordinate, sorted by distance. |
| `camera_view` | Full record for a single camera id. |
| `plugin_list` | Terse list of installed UI plugins. |
| `plugin_catalog` | Full UI manifests + engine seeders + camera sources + cross-id mapping (use this when an agent isn't sure which id to pass to `layer_toggle` or `engine_query`). |
| `engine_query` | Live data from a data-engine seeder (aviation, wildfires, earthquakes, satellite, iss, sanctions, gps_jamming, conflict_events, cyber_attacks, civil_unrest, surveillance_satellites). |
| `engine_health` | Engine status + last-fetch timestamps per seeder. |
| `geocode` | Freeform place name → lat/lon via OpenStreetMap Nominatim. |

### Write — drive the running browser globe (4)

These require the upstream WWV agent-bus PR ([silvertakana/worldwideview#79](https://github.com/silvertakana/worldwideview/pull/79)) to be applied on the target instance, with `NEXT_PUBLIC_WWV_AGENT_BUS_ENABLED=true` set at build time. Until that PR lands, drop the patch in via fork.

| Tool | What it does |
|---|---|
| `globe_fly_to` | Fly the camera to a lat/lon (with optional alt/heading/distance). |
| `globe_face_towards` | Reorient without flying. |
| `layer_toggle` | Enable/disable a plugin layer. |
| `focus_entity` | Select an entity (camera, aircraft, etc.) by id, opening its detail panel. |

### Auth model

Three options, in priority order — use whichever fits:

1. **`WWV_USERNAME` + `WWV_PASSWORD` env vars.** Server auto-logs-in at startup. Recommended.
2. **`~/.config/wwv-mcp/credentials` file** (chmod 600, format `KEY=value` lines). Same env-var names. Refused if file permissions are loose.
3. **`WWV_SESSION_TOKEN` env var** — explicit Auth.js session cookie value, copied from browser DevTools → Application → Cookies → `__Secure-authjs.session-token`. Useful for short-lived testing.

Read-only camera + engine endpoints are public on a self-hosted instance and work without auth.

## Install

```sh
git clone https://github.com/szski/wwv-mcp
cd wwv-mcp
npm install
npm run build
```

## Configure

Copy `.env.example` to `.env` and set the URLs (or pass them via the host's MCP env config — see below). The credential file at `~/.config/wwv-mcp/credentials` is the most portable place for username/password:

```sh
mkdir -p ~/.config/wwv-mcp
cat > ~/.config/wwv-mcp/credentials <<'EOF'
WWV_USERNAME=you@example.com
WWV_PASSWORD=your-password
EOF
chmod 600 ~/.config/wwv-mcp/credentials
```

### Self-signed certs (mkcert)

If WWV is served over an mkcert-issued cert (typical local-host setup), point Node at the mkcert root CA:

```sh
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
```

Or install the mkcert CA system-wide (`mkcert -install`) and Node will pick it up via the OS trust store.

### 1Password (most secure path)

A wrapper script at `scripts/wwv-mcp-with-1password.sh` fetches credentials from 1Password (via the `op` CLI) just for the MCP-server lifetime. Configure the host MCP client to invoke that script instead of `node` directly. Setup:

```sh
brew install 1password-cli && op signin
# create a 1Password item titled "WWV" with username + password fields
chmod +x scripts/wwv-mcp-with-1password.sh
```

## Wire into Claude Code

Add to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "wwv": {
      "command": "node",
      "args": ["/absolute/path/to/wwv-mcp/dist/index.js"],
      "env": {
        "WWV_BASE_URL": "https://your-wwv-host.example",
        "WWV_ENGINE_URL": "http://localhost:5001",
        "NODE_EXTRA_CA_CERTS": "/Users/you/Library/Application Support/mkcert/rootCA.pem"
      }
    }
  }
}
```

Then `/mcp` in Claude Code should list `wwv` with all 15 tools available.

## Wire into Claude Desktop

Similar — edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and add the same `mcpServers.wwv` block.

## Architecture

- `src/index.ts` — entry; creates `McpServer`, attaches stdio transport, runs `tryAutoLogin()` before tools start.
- `src/config.ts` — env loading.
- `src/auth.ts` — login helpers, file-based credential loading, session-token state.
- `src/client.ts` — REST wrappers around WWV + engine.
- `src/bus.ts` — agent-bus client. POSTs `AgentAction` JSON to `/api/agent/publish` on the WWV instance; the server fans out via SSE to every browser tab belonging to the same user. **Fully implemented** — drives `globe_fly_to`, `globe_face_towards`, `layer_toggle`, `focus_entity`.
- `src/tools.ts` — all 15 tools as `(name, schema, handler)` triples plus a `registerAll()` helper. Adding a tool: add an entry, no other changes.

## How drive-the-globe actually works

```
Agent (Claude/Cursor/etc.)
   │  globe_fly_to({lat, lon, distance})
   ▼
wwv-mcp                                        on disk: ~/.config/wwv-mcp/credentials
   │  POST /api/agent/publish                  ┌─ runs auth_login on startup
   │  Cookie: __Secure-authjs.session-token=… ─┘
   ▼
WWV server (worldwideview Next.js app)
   │  AgentBus.publish(userId, action)         ┌─ scoped per session.user.id
   │  SSE message → every subscriber           │  user A's publish never reaches user B
   ▼
Browser tab (https://your-instance/...)
   │  AgentBusSubscriber.onmessage
   │  dataBus.emit("cameraGoTo", {...})        ┌─ same event the UI buttons emit
   ▼
Cesium camera flies to (lat, lon)             ─┘
   │
   ▼
{ ok: true, delivered: 1, subscribers: 1 }   ← MCP tool result back to the agent
```

Per-user routing is enforced server-side in the `AgentBus.publish(userId, action)` call. Multi-tenant safe.

## Examples

- *"What camera sources are available right now?"* → `camera_list_sources`
- *"Find me 10 traffic cameras near downtown Seattle."* → `camera_near {lat:47.6062, lon:-122.3321, limit:10}`
- *"Show me current wildfire data."* → `engine_query {plugin:"wildfires"}`
- *"Fly me to the nearest wildfire to Charlotte."* → `engine_query` for wildfires, find nearest, `globe_fly_to`
- *"What's broken right now?"* → `system_status`
- *"What's the relationship between the engine seeder ids and UI plugin ids?"* → `plugin_catalog`
- *"Toggle on the cyber threats layer."* → `layer_toggle {pluginId:"cyber-attacks", enabled:true}`

## Companion repos

- [silvertakana/worldwideview#79](https://github.com/silvertakana/worldwideview/pull/79) — agent-bus integration in WWV core. Required for write tools to work.
- [silvertakana/wwv-data-engine#3](https://github.com/silvertakana/wwv-data-engine/pull/3) — fixes WS routing for plugins whose UI id doesn't match the seeder name (`cyber-attacks` vs `cyber_attacks`, etc.). Independent of the agent bus.

## License

MIT.
