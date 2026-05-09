/**
 * Auth helpers — runtime cookie-based login against Auth.js's credentials
 * provider. Lets the MCP server authenticate itself instead of the operator
 * pasting `__Secure-authjs.session-token` from the browser.
 *
 * Credential sources (priority order):
 *   1. Runtime env: WWV_USERNAME + WWV_PASSWORD (set by Claude config or
 *      a wrapper script — `op run` works cleanly here).
 *   2. File: $XDG_CONFIG_HOME/wwv-mcp/credentials or ~/.config/wwv-mcp/credentials
 *      (chmod 600 strongly recommended). Two lines: `WWV_USERNAME=...` and
 *      `WWV_PASSWORD=...`.
 *   3. Static token: WWV_SESSION_TOKEN env var (the original v0.1.0 path).
 *
 * Token is never written to disk and is not logged.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

let runtimeToken: string | undefined = config.sessionToken;
let runtimeUser: string | undefined = undefined;

/**
 * Load credentials from `~/.config/wwv-mcp/credentials` if present.
 * Does NOT override values already set in process.env. Silent on file
 * missing; throws on file present but unreadable.
 */
function loadCredentialsFromFile(): void {
    const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
    const credPath = path.join(configHome, "wwv-mcp", "credentials");
    if (!fs.existsSync(credPath)) return;

    // Refuse to read group/world-readable credential files.
    const stat = fs.statSync(credPath);
    const worldReadable = (stat.mode & 0o077) !== 0;
    if (worldReadable) {
        console.error(
            `[wwv-mcp] ${credPath} has loose permissions (mode ${(stat.mode & 0o777).toString(8)}). ` +
            `Run \`chmod 600 "${credPath}"\` and retry.`,
        );
        return;
    }

    const text = fs.readFileSync(credPath, "utf-8");
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 1) continue;
        const k = line.slice(0, eq).trim();
        let v = line.slice(eq + 1).trim();
        // Strip optional surrounding quotes.
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
        }
        if (!process.env[k]) process.env[k] = v;
    }
}

loadCredentialsFromFile();

export function currentToken(): string | undefined {
    return runtimeToken;
}

export function currentUser(): string | undefined {
    return runtimeUser;
}

/** Parse a `Set-Cookie` header line for the named cookie's value. */
function extractCookie(header: string | null, name: string): string | undefined {
    if (!header) return undefined;
    // fetch's Set-Cookie may concatenate multiple cookies with commas. We
    // can't safely split on comma (Expires=...,...), but matching the name
    // prefix and reading until the next semicolon is robust enough for our
    // purposes here.
    const m = header.match(new RegExp(`${name}=([^;]+)`));
    return m ? m[1] : undefined;
}

/** Authenticate by email + password; cache the resulting session cookie. */
export async function login(email: string, password: string): Promise<{
    ok: true; user: string;
} | {
    ok: false; error: string;
}> {
    // Step 1: fetch CSRF token (sets __Host-authjs.csrf-token cookie).
    const csrfRes = await fetch(`${config.wwvBaseUrl}/api/auth/csrf`, {
        headers: { "User-Agent": "wwv-mcp/0.1.0" },
    });
    if (!csrfRes.ok) {
        return { ok: false, error: `CSRF fetch failed: ${csrfRes.status}` };
    }
    const csrfBody = (await csrfRes.json()) as { csrfToken?: string };
    const csrfToken = csrfBody.csrfToken;
    if (!csrfToken) return { ok: false, error: "No csrfToken in response" };
    const csrfCookie = extractCookie(csrfRes.headers.get("set-cookie"), "__Host-authjs.csrf-token");
    if (!csrfCookie) return { ok: false, error: "No CSRF cookie set" };

    // Step 2: POST credentials with the CSRF cookie + token.
    const form = new URLSearchParams();
    form.set("csrfToken", csrfToken);
    form.set("email", email);
    form.set("password", password);
    form.set("callbackUrl", config.wwvBaseUrl);

    const loginRes = await fetch(
        `${config.wwvBaseUrl}/api/auth/callback/credentials`,
        {
            method: "POST",
            redirect: "manual",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "wwv-mcp/0.1.0",
                "X-Auth-Return-Redirect": "1",
                "Cookie": `__Host-authjs.csrf-token=${csrfCookie}`,
            },
            body: form.toString(),
        },
    );

    // On bad credentials, NextAuth returns JSON `{url:".../login?error=CredentialsSignin..."}` with a 200.
    let resBody: { url?: string } = {};
    try {
        resBody = (await loginRes.json()) as { url?: string };
    } catch { /* not JSON */ }
    if (resBody.url && /error=/.test(resBody.url)) {
        return { ok: false, error: "Invalid credentials" };
    }

    const sessionCookie = extractCookie(loginRes.headers.get("set-cookie"), "__Secure-authjs.session-token");
    if (!sessionCookie) return { ok: false, error: "No session cookie returned by Auth.js" };

    runtimeToken = sessionCookie;
    runtimeUser = email;
    return { ok: true, user: email };
}

/** Auto-login at process start if WWV_USERNAME + WWV_PASSWORD are set. */
export async function tryAutoLogin(): Promise<void> {
    const u = process.env.WWV_USERNAME;
    const p = process.env.WWV_PASSWORD;
    if (!u || !p) return;
    if (runtimeToken) return; // explicit token already provided
    const result = await login(u, p);
    if (!result.ok) {
        console.error(`[wwv-mcp] auto-login failed: ${result.error}`);
    }
}
