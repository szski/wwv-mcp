/**
 * The 7 read-only tools exposed to the agent.
 *
 * Each tool is a (name, schema, handler) triple registered against an
 * `McpServer`. Adding a new tool: add an entry below; the bootstrap in
 * `index.ts` iterates the array.
 *
 * All handlers return MCP `content` arrays. Text payloads are JSON-stringified
 * with reasonable indentation so an agent reading the tool result sees
 * structured data, not a dense single line.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wwv, engine, haversineKm } from "./client.js";
import { publish } from "./bus.js";
import { login, currentToken, currentUser } from "./auth.js";
import { config } from "./config.js";

type ToolHandler = (input: any) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}>;

interface ToolDef {
    name: string;
    description: string;
    inputSchema: z.ZodRawShape;
    handler: ToolHandler;
}

function asJsonContent(value: unknown) {
    return {
        content: [
            { type: "text" as const, text: JSON.stringify(value, null, 2) },
        ],
    };
}

function asError(message: string) {
    return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
    };
}

// ─── 1. camera_list_sources ─────────────────────────────────────────

const cameraListSources: ToolDef = {
    name: "camera_list_sources",
    description:
        "List all camera adapters registered on this WorldWideView instance, " +
        "with display name, region, key requirements, and last-fetch health. " +
        "Returns the contents of /api/camera/list.",
    inputSchema: {},
    handler: async () => {
        const data = await wwv.listCameraSources();
        return asJsonContent(data);
    },
};

// ─── 2. camera_get ──────────────────────────────────────────────────

const cameraGet: ToolDef = {
    name: "camera_get",
    description:
        "Fetch cameras from one or more sources. Pass `sources` as an array " +
        "of adapter ids (e.g. ['caltrans', 'ncdot']) to limit the merge. " +
        "Omit or pass null to fetch all known sources. Returns the full " +
        "GeoJSON-style records — typically thousands; consider using " +
        "camera_near or filtering by source for narrower queries.",
    inputSchema: {
        sources: z
            .array(z.string())
            .nullish()
            .describe("Adapter ids to include. Omit for all sources."),
    },
    handler: async ({ sources }: { sources?: string[] | null }) => {
        const data = await wwv.getTraffic(sources ?? undefined);
        return asJsonContent(data);
    },
};

// ─── 3. camera_near ─────────────────────────────────────────────────

const cameraNear: ToolDef = {
    name: "camera_near",
    description:
        "Find cameras within `radius_km` of a coordinate, sorted by distance. " +
        "Optional `sources` filter limits the search to specific adapters. " +
        "Optional `limit` caps the number of cameras returned (default 25, " +
        "max 200). Returns id, name, lat/lon, distance_km, source, stream URL.",
    inputSchema: {
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        radius_km: z.number().positive().max(2000).default(50),
        sources: z.array(z.string()).nullish(),
        limit: z.number().int().positive().max(200).default(25),
    },
    handler: async ({ lat, lon, radius_km, sources, limit }: {
        lat: number; lon: number; radius_km: number;
        sources?: string[] | null; limit: number;
    }) => {
        const data = await wwv.getTraffic(sources ?? undefined);
        const cameras: any[] = data?.cameras ?? [];
        const ranked = cameras
            .map((c) => {
                const [clon, clat] = c.geometry?.coordinates ?? [];
                if (typeof clat !== "number" || typeof clon !== "number") return null;
                const distance_km = haversineKm(lat, lon, clat, clon);
                if (distance_km > radius_km) return null;
                const p = c.properties ?? {};
                return {
                    id: p.id,
                    name: p.name,
                    lat: clat,
                    lon: clon,
                    distance_km: Math.round(distance_km * 100) / 100,
                    source: p.source,
                    stream: p.stream,
                    streamType: p.streamType,
                    region: p.region,
                    city: p.city,
                };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null)
            .sort((a, b) => a.distance_km - b.distance_km)
            .slice(0, limit);
        return asJsonContent({
            origin: { lat, lon },
            radius_km,
            count: ranked.length,
            cameras: ranked,
        });
    },
};

// ─── 4. camera_view ─────────────────────────────────────────────────

const cameraView: ToolDef = {
    name: "camera_view",
    description:
        "Fetch the full record for a single camera by its id. Useful after " +
        "camera_near has identified a candidate and you want the stream URL " +
        "+ all properties for it. Searches across all sources.",
    inputSchema: {
        id: z.string().describe("Camera id, as returned by camera_near or camera_get."),
    },
    handler: async ({ id }: { id: string }) => {
        const data = await wwv.getTraffic();
        const cameras: any[] = data?.cameras ?? [];
        const found = cameras.find((c) => c?.properties?.id === id);
        if (!found) return asError(`No camera with id "${id}" found.`);
        return asJsonContent(found);
    },
};

// ─── 5. plugin_list ─────────────────────────────────────────────────

const pluginList: ToolDef = {
    name: "plugin_list",
    description:
        "Terse list of installed UI plugins (id, name, version, type, " +
        "description, trust, category) — useful for quick browsing. For the " +
        "full manifests + engine seeders + camera sources + cross-system " +
        "id mappings in one call, use `plugin_catalog` instead. Requires " +
        "auth (auth_login or WWV_SESSION_TOKEN).",
    inputSchema: {},
    handler: async () => {
        try {
            const data = await wwv.listInstalledPlugins();
            const manifests: any[] = data?.manifests ?? [];
            const summary = manifests.map((m) => ({
                id: m.id,
                name: m.name,
                version: m.version,
                type: m.type,
                description: m.description,
                trust: m.trust,
                category: m.category,
            }));
            return asJsonContent({ count: summary.length, plugins: summary });
        } catch (e: any) {
            return asError(
                `Failed to list plugins: ${e.message}. ` +
                "Did you authenticate (auth_login) or set WWV_SESSION_TOKEN?",
            );
        }
    },
};

// ─── plugin_catalog (everything an agent needs to join IDs) ─────────
//
// The same conceptual entity gets different identifiers in different layers:
//   - data engine seeder: "wildfires", "conflictEvents", "gps_jamming"
//   - UI plugin id:       "wildfire",  "conflict-zones", "gps-jamming"
//   - camera adapter id:  "caltrans", "ncdot", "ny511" (own namespace)
//
// Without a single call that surfaces all three plus the mapping, agents
// trial-and-error their way to layer_toggle / engine_query calls and burn
// turns. This tool is the one-stop catalog.
//
// The mappings below are hard-coded from observed pairings — when the data
// engine adds a seeder that maps to a new UI plugin, add an entry here.
// Agents can also infer from name similarity when an entry is missing.

const SEEDER_TO_UI_PLUGIN: Record<string, string> = {
    wildfires: "wildfire",
    conflictEvents: "conflict-zones",
    gps_jamming: "gps-jamming",
    cyber_attacks: "cyber-attacks",
    civilUnrest: "civil-unrest",
    surveillance_satellites: "surveillance-satellites",
    // Identity mappings (engine seeder id == UI plugin id), listed
    // explicitly so agents don't have to guess that they're stable.
    aviation: "aviation",
    earthquakes: "earthquakes",
    satellite: "satellite",
    iss: "satellite",       // ISS positions render via the satellite plugin
    sanctions: "sanctions", // no built-in UI plugin yet; aspirational
};

const pluginCatalog: ToolDef = {
    name: "plugin_catalog",
    description:
        "Single-call catalog of everything an agent needs to drive plugins, " +
        "engine queries, and camera sources without trial-and-error. " +
        "Returns: full UI plugin manifests (rendering / dataSource / " +
        "capabilities included), all data-engine seeders with last-fetch " +
        "timestamps, all camera adapter metadata, and a known-mappings " +
        "table from engine seeder ids → UI plugin ids (e.g. " +
        "'wildfires' → 'wildfire'). Use this BEFORE calling layer_toggle " +
        "or engine_query when the agent isn't sure of the right id.",
    inputSchema: {},
    handler: async () => {
        const [uiResult, engineResult, cameraResult] = await Promise.allSettled([
            wwv.listInstalledPlugins(),
            engine.manifest(),
            wwv.listCameraSources(),
        ]);

        const uiManifests: any[] =
            uiResult.status === "fulfilled" ? (uiResult.value?.manifests ?? []) : [];
        const engineManifest: any =
            engineResult.status === "fulfilled" ? engineResult.value : null;
        const cameraAdapters: any[] =
            cameraResult.status === "fulfilled" ? (cameraResult.value?.adapters ?? []) : [];

        // Build reverse map (ui plugin id → engine seeder id) for convenience.
        const uiToSeeder: Record<string, string> = {};
        for (const [seeder, ui] of Object.entries(SEEDER_TO_UI_PLUGIN)) {
            // When several seeders map to the same UI (e.g. iss + satellite
            // both → "satellite"), keep the first; agents can find the others
            // by inspecting `known_mappings` directly.
            if (!uiToSeeder[ui]) uiToSeeder[ui] = seeder;
        }

        return asJsonContent({
            ui_plugins: uiManifests,
            engine_seeders: engineManifest?.plugins ?? [],
            engine_seeder_status:
                engineResult.status === "fulfilled"
                    ? engineManifest
                    : { error: (engineResult as PromiseRejectedResult).reason?.message ?? "unreachable" },
            camera_sources: cameraAdapters,
            known_mappings: {
                seeder_to_ui_plugin: SEEDER_TO_UI_PLUGIN,
                ui_plugin_to_seeder: uiToSeeder,
            },
            errors: {
                ui_plugins:
                    uiResult.status === "rejected"
                        ? (uiResult.reason?.message ?? String(uiResult.reason))
                        : null,
                engine:
                    engineResult.status === "rejected"
                        ? (engineResult.reason?.message ?? String(engineResult.reason))
                        : null,
                camera_sources:
                    cameraResult.status === "rejected"
                        ? (cameraResult.reason?.message ?? String(cameraResult.reason))
                        : null,
            },
        });
    },
};

// ─── 6. engine_query ────────────────────────────────────────────────

const engineQuery: ToolDef = {
    name: "engine_query",
    description:
        "Fetch live data from the WorldWideView data engine for a given " +
        "plugin id (e.g. aviation, earthquakes, wildfires, satellite, " +
        "iss, sanctions, gps_jamming, conflict_events, cyber_attacks, " +
        "civil_unrest, surveillance_satellites). Returns whatever the engine " +
        "has cached for that seeder.",
    inputSchema: {
        plugin: z.string().describe("Engine plugin id from /manifest."),
    },
    handler: async ({ plugin }: { plugin: string }) => {
        try {
            const data = await engine.data(plugin);
            return asJsonContent(data);
        } catch (e: any) {
            return asError(
                `engine_query failed: ${e.message}. ` +
                "Use engine_health first to check which seeders are available.",
            );
        }
    },
};

// ─── 7. engine_health ───────────────────────────────────────────────

const engineHealth: ToolDef = {
    name: "engine_health",
    description:
        "Check the WorldWideView data engine's health endpoint. Returns " +
        "engine version, list of available seeders, and timestamp of each " +
        "seeder's last successful fetch (so you can see what's stale).",
    inputSchema: {},
    handler: async () => {
        const [health, manifest] = await Promise.all([
            engine.health().catch((e) => ({ error: e.message })),
            engine.manifest().catch((e) => ({ error: e.message })),
        ]);
        return asJsonContent({ health, manifest });
    },
};

// ─── 8. globe_fly_to (drives the browser globe) ─────────────────────

const globeFlyTo: ToolDef = {
    name: "globe_fly_to",
    description:
        "Fly the running WWV browser globe to a coordinate. Requires the agent " +
        "bus to be enabled on the WWV instance (NEXT_PUBLIC_WWV_AGENT_BUS_ENABLED=true) " +
        "and WWV_SESSION_TOKEN to be set on this MCP server. Returns the number " +
        "of browser tabs that received the command (0 means no tab is open).",
    inputSchema: {
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        alt: z.number().nonnegative().nullish().describe("Target altitude in meters."),
        heading: z.number().min(0).max(360).nullish().describe("Compass heading 0–360°."),
        distance: z.number().positive().nullish().describe("Camera distance from target in meters."),
    },
    handler: async ({ lat, lon, alt, heading, distance }: {
        lat: number; lon: number; alt?: number | null; heading?: number | null; distance?: number | null;
    }) => {
        try {
            const result = await publish({
                action: "fly_to",
                lat, lon,
                alt: alt ?? undefined,
                heading: heading ?? undefined,
                distance: distance ?? undefined,
            });
            return asJsonContent(result);
        } catch (e: any) {
            return asError(e.message);
        }
    },
};

// ─── 9. globe_face_towards ──────────────────────────────────────────

const globeFaceTowards: ToolDef = {
    name: "globe_face_towards",
    description:
        "Reorient the WWV browser globe camera to face a coordinate without " +
        "necessarily flying to it. Useful for tracking a target while keeping " +
        "the current viewpoint.",
    inputSchema: {
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        alt: z.number().nonnegative().nullish(),
    },
    handler: async ({ lat, lon, alt }: { lat: number; lon: number; alt?: number | null }) => {
        try {
            const result = await publish({
                action: "face_towards",
                lat, lon,
                alt: alt ?? undefined,
            });
            return asJsonContent(result);
        } catch (e: any) {
            return asError(e.message);
        }
    },
};

// ─── 10. layer_toggle ───────────────────────────────────────────────

const layerToggle: ToolDef = {
    name: "layer_toggle",
    description:
        "Enable or disable a plugin's layer in the running WWV browser. " +
        "Use plugin_list to discover available pluginIds.",
    inputSchema: {
        pluginId: z.string(),
        enabled: z.boolean(),
    },
    handler: async ({ pluginId, enabled }: { pluginId: string; enabled: boolean }) => {
        try {
            const result = await publish({ action: "layer_toggle", pluginId, enabled });
            return asJsonContent(result);
        } catch (e: any) {
            return asError(e.message);
        }
    },
};

// ─── 11. focus_entity ───────────────────────────────────────────────

const focusEntity: ToolDef = {
    name: "focus_entity",
    description:
        "Select a specific entity (camera, aircraft, etc.) in the running WWV " +
        "browser, opening its detail panel. Pair with camera_near or " +
        "engine_query to find candidate ids first.",
    inputSchema: {
        pluginId: z.string(),
        entityId: z.string(),
    },
    handler: async ({ pluginId, entityId }: { pluginId: string; entityId: string }) => {
        try {
            const result = await publish({ action: "select_entity", pluginId, entityId });
            return asJsonContent(result);
        } catch (e: any) {
            return asError(e.message);
        }
    },
};

// ─── 12. auth_login (eliminates manual cookie extraction) ───────────

const authLogin: ToolDef = {
    name: "auth_login",
    description:
        "Authenticate this MCP server against the WWV instance using email + " +
        "password. The captured session is held in memory and used by every " +
        "subsequent write tool (globe_fly_to, layer_toggle, etc.). Replaces " +
        "the WWV_SESSION_TOKEN cookie-paste workflow. If WWV_USERNAME and " +
        "WWV_PASSWORD env vars are set, this happens automatically at startup.",
    inputSchema: {
        email: z.string().email(),
        password: z.string().min(1),
    },
    handler: async ({ email, password }: { email: string; password: string }) => {
        const result = await login(email, password);
        if (!result.ok) return asError(`Login failed: ${result.error}`);
        return asJsonContent({ ok: true, user: result.user });
    },
};

// ─── 13. system_status (one-shot health probe) ──────────────────────

const systemStatus: ToolDef = {
    name: "system_status",
    description:
        "Check end-to-end health: WWV reachability, data engine reachability, " +
        "agent bus enabled state, current subscriber count, auth state. Useful " +
        "as the agent's first call so it can tell the operator exactly what " +
        "needs fixing if write tools won't work.",
    inputSchema: {},
    handler: async () => {
        const result: Record<string, unknown> = {
            wwv_base_url: config.wwvBaseUrl,
            engine_base_url: config.engineBaseUrl,
            auth: {
                ok: !!currentToken(),
                user: currentUser() ?? null,
                source: currentToken()
                    ? (currentUser() ? "login" : "WWV_SESSION_TOKEN env")
                    : "none",
            },
        };

        // WWV reachability — /api/camera/list is public, fast.
        const t1 = Date.now();
        try {
            await wwv.listCameraSources();
            result.wwv_reachable = { ok: true, latency_ms: Date.now() - t1 };
        } catch (e: any) {
            result.wwv_reachable = { ok: false, error: e.message };
        }

        // Engine reachability.
        const t2 = Date.now();
        try {
            const m = await engine.manifest();
            result.engine_reachable = {
                ok: true,
                latency_ms: Date.now() - t2,
                seeders: m?.plugins?.length ?? 0,
            };
        } catch (e: any) {
            result.engine_reachable = { ok: false, error: e.message };
        }

        // Agent bus: publish a ping. delivered>0 means a browser tab is subscribed.
        if (currentToken()) {
            try {
                const r = await publish({ action: "ping", ts: Date.now() });
                result.agent_bus = {
                    publish_ok: true,
                    delivered: r.delivered,
                    subscribers: r.subscribers,
                };
            } catch (e: any) {
                result.agent_bus = { publish_ok: false, error: e.message };
            }
        } else {
            result.agent_bus = { publish_ok: false, error: "not authenticated" };
        }

        return asJsonContent(result);
    },
};

// ─── 14. geocode (place name → lat/lon) ─────────────────────────────

const geocode: ToolDef = {
    name: "geocode",
    description:
        "Convert a freeform place name (\"Raleigh, NC\", \"Eiffel Tower\", " +
        "\"my house at 123 Main St\") into latitude/longitude candidates via " +
        "OpenStreetMap Nominatim. Returns up to `limit` matches sorted by " +
        "Nominatim's relevance ranking, each with display_name, lat, lon, " +
        "and bounding box. Pair with globe_fly_to: geocode → take the first " +
        "result → fly_to.",
    inputSchema: {
        query: z.string().min(2).describe("Freeform place name."),
        limit: z.number().int().positive().max(10).default(5),
    },
    handler: async ({ query, limit }: { query: string; limit: number }) => {
        const url =
            "https://nominatim.openstreetmap.org/search?format=json" +
            `&q=${encodeURIComponent(query)}&limit=${limit}`;
        try {
            const res = await fetch(url, {
                headers: {
                    "User-Agent": "wwv-mcp/0.1.0 (https://github.com/silvertakana/worldwideview)",
                    Accept: "application/json",
                },
            });
            if (!res.ok) return asError(`Nominatim ${res.status} ${res.statusText}`);
            const raw = (await res.json()) as Array<{
                place_id: number;
                display_name: string;
                lat: string;
                lon: string;
                boundingbox?: string[];
                type?: string;
                class?: string;
            }>;
            const results = raw.map((r) => ({
                display_name: r.display_name,
                lat: parseFloat(r.lat),
                lon: parseFloat(r.lon),
                bbox: r.boundingbox?.map(parseFloat),
                type: r.type,
                category: r.class,
            }));
            return asJsonContent({ query, count: results.length, results });
        } catch (e: any) {
            return asError(`geocode failed: ${e.message}`);
        }
    },
};

export const allTools: ToolDef[] = [
    // System
    authLogin,
    systemStatus,
    // Read
    cameraListSources,
    cameraGet,
    cameraNear,
    cameraView,
    pluginList,
    pluginCatalog,
    engineQuery,
    engineHealth,
    geocode,
    // Write (drive the browser globe)
    globeFlyTo,
    globeFaceTowards,
    layerToggle,
    focusEntity,
];

export function registerAll(server: McpServer): void {
    for (const tool of allTools) {
        server.registerTool(
            tool.name,
            {
                description: tool.description,
                inputSchema: tool.inputSchema,
            },
            tool.handler as any,
        );
    }
}
