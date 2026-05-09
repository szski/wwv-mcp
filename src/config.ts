/**
 * Runtime configuration. Loaded from process env at startup so the MCP
 * server can be invoked via Claude Code / Claude Desktop with environment
 * variables set in their respective config files.
 */

function trimTrailingSlash(s: string): string {
    return s.replace(/\/+$/, "");
}

function require_env(key: string): string {
    const v = process.env[key];
    if (!v) {
        throw new Error(`Missing required env var: ${key}`);
    }
    return trimTrailingSlash(v);
}

export const config = {
    wwvBaseUrl: require_env("WWV_BASE_URL"),
    engineBaseUrl: require_env("WWV_ENGINE_URL"),
    sessionToken: process.env.WWV_SESSION_TOKEN,
} as const;
