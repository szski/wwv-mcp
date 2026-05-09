/**
 * Bidirectional channel for driving the running WWV browser session.
 *
 * The agent posts an action to `/api/agent/publish` on the WWV server. The
 * server broadcasts via Server-Sent Events on `/api/agent/stream` to every
 * connected browser tab. The browser-side `AgentBusSubscriber` re-emits the
 * action onto the React app's existing `dataBus`, so an agent saying
 * "fly to Raleigh" lands on the same event a "Fly to" UI button would.
 *
 * Auth: same Auth.js session-cookie gate as `/api/marketplace/*`. Set
 * `WWV_SESSION_TOKEN` for the publish endpoint to accept the request. If
 * the token isn't set, write tools return a clear error pointing the
 * operator at the README.
 */

import { config } from "./config.js";
import { currentToken } from "./auth.js";

export type AgentAction =
    | { action: "fly_to"; lat: number; lon: number; alt?: number; heading?: number; distance?: number }
    | { action: "face_towards"; lat: number; lon: number; alt?: number }
    | { action: "layer_toggle"; pluginId: string; enabled: boolean }
    | { action: "highlight_layer"; pluginId: string }
    | { action: "select_entity"; pluginId: string; entityId: string }
    | { action: "ping"; ts: number };

export interface PublishResult {
    ok: boolean;
    delivered: number;
    subscribers: number;
}

export async function publish(action: AgentAction): Promise<PublishResult> {
    const token = currentToken();
    if (!token) {
        throw new Error(
            "Not authenticated. Either set WWV_USERNAME + WWV_PASSWORD env vars " +
            "for auto-login, call the auth_login tool, or set WWV_SESSION_TOKEN.",
        );
    }
    const res = await fetch(`${config.wwvBaseUrl}/api/agent/publish`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Cookie": `__Secure-authjs.session-token=${token}`,
            "User-Agent": "wwv-mcp/0.1.0",
        },
        body: JSON.stringify(action),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(
            `publish ${action.action} → ${res.status} ${res.statusText}\n${text.slice(0, 300)}`,
        );
    }
    return JSON.parse(text) as PublishResult;
}
