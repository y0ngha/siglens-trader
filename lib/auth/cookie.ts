/**
 * Session cookie helpers — pure string handling, no I/O.
 *
 * The cookie value is the session row's uuid. Nothing is signed: the id is
 * high-entropy (uuid v4) and every request resolves it against the `sessions`
 * table, so a forged value cannot be validated without a matching row.
 */

/**
 * HttpOnly cookie carrying the session id.
 *
 * CSRF defence is `SameSite=Lax` alone, deliberately. Lax withholds the cookie from
 * cross-site form POSTs and sub-resource requests, which covers every state-changing
 * route here (`/api/config`, `/api/approve/:id`, `/api/positions/:id/close`,
 * `/api/trades`) — they are all POST, and none is reachable by a top-level GET
 * navigation, the one case Lax still allows. An Origin/Referer check was considered
 * and left out: it would have to be threaded through every handler for no additional
 * coverage on a single-operator tool. Add one if a state-changing GET is ever
 * introduced, or if the cookie has to move to SameSite=None.
 */
export const SESSION_COOKIE_NAME = 'trader_session';

/** Session lifetime (30 days) — matches siglens' DEFAULT_SESSION_TTL_SECONDS. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const EXPIRED_COOKIE_DATE = 'Thu, 01 Jan 1970 00:00:00 GMT';

/** Read a cookie value out of a request's `Cookie` header. Returns null when absent. */
export function readCookie(req: Request, name: string): string | null {
    const header = req.headers.get('cookie');
    if (!header) return null;

    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() !== name) continue;

        const raw = part.slice(eq + 1).trim();
        try {
            return decodeURIComponent(raw);
        } catch {
            // `decodeURIComponent` throws URIError on a malformed escape ("%", "%zz").
            // The header is attacker-controlled and this runs before any auth check, so
            // throwing here would turn `Cookie: trader_session=%` into a 500 on every
            // guarded route. Fall back to the raw value — it simply won't match a session.
            return raw;
        }
    }
    return null;
}

/** Read the session id from the request, if any. */
export function readSessionCookie(req: Request): string | null {
    return readCookie(req, SESSION_COOKIE_NAME);
}

/**
 * `Secure` is dropped outside production so `vite dev` over plain http keeps the
 * cookie. Production is always served through the Cloudflare tunnel over https.
 */
function secureAttribute(): string {
    return process.env.NODE_ENV === 'production' ? '; Secure' : '';
}

/** Build the `Set-Cookie` value that establishes a session. */
export function serializeSessionCookie(
    sessionId: string,
    maxAgeSeconds = SESSION_TTL_SECONDS,
): string {
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureAttribute()}`;
}

/** Build the `Set-Cookie` value that clears the session cookie. */
export function serializeClearedSessionCookie(): string {
    return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=${EXPIRED_COOKIE_DATE}${secureAttribute()}`;
}
