/**
 * Thin REST wrappers around WorldWideView and its data engine.
 *
 * Each method takes an explicit base URL + path; the only "magic" is bolting
 * on the session-cookie header when WWV_SESSION_TOKEN is set, so the MCP
 * server can call session-protected endpoints (`/api/marketplace/*`)
 * impersonating a logged-in user.
 *
 * Self-signed TLS note (mkcert): if WWV is served over a self-signed cert
 * (the Caddy + mkcert local-host pattern), set `NODE_EXTRA_CA_CERTS` to the
 * path of your mkcert root (`mkcert -CAROOT` prints it) in the MCP server's
 * env, OR install the mkcert CA system-wide. README has the snippet.
 */

import { config } from "./config.js";
import { currentToken } from "./auth.js";

interface FetchOptions {
    method?: "GET" | "POST";
    body?: unknown;
    auth?: boolean;
}

async function callJson(url: string, opts: FetchOptions = {}): Promise<any> {
    const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": "wwv-mcp/0.1.0",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth) {
        const token = currentToken();
        if (token) {
            // Auth.js stores the JWT under a cookie named with the secure prefix
            // when the page is served over https. Match that.
            headers["Cookie"] = `__Secure-authjs.session-token=${token}`;
        }
    }

    const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText} — ${url}\n${text.slice(0, 500)}`);
    }
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

// ─── WWV REST endpoints ─────────────────────────────────────────────

export const wwv = {
    listCameraSources: () =>
        callJson(`${config.wwvBaseUrl}/api/camera/list`),

    getTraffic: (sources?: string[]) => {
        const qs = sources && sources.length > 0 ? `?sources=${encodeURIComponent(sources.join(","))}` : "";
        return callJson(`${config.wwvBaseUrl}/api/camera/traffic${qs}`);
    },

    listInstalledPlugins: () =>
        callJson(`${config.wwvBaseUrl}/api/marketplace/load`, { auth: true }),
};

// ─── Data-engine REST endpoints ─────────────────────────────────────

export const engine = {
    health: () => callJson(`${config.engineBaseUrl}/health`),
    manifest: () => callJson(`${config.engineBaseUrl}/manifest`),
    data: (plugin: string) =>
        callJson(`${config.engineBaseUrl}/data/${encodeURIComponent(plugin)}`),
};

// ─── Geo helpers (used by camera_near) ──────────────────────────────

export function haversineKm(
    lat1: number, lon1: number, lat2: number, lon2: number,
): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

