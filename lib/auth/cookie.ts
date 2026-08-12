/**
 * Session cookie helpers — pure string handling, no I/O.
 *
 * The cookie value is the session row's uuid. Nothing is signed: the id is
 * high-entropy (uuid v4) and every request resolves it against the `sessions`
 * table, so a forged value cannot be validated without a matching row.
 */

/** HttpOnly cookie carrying the session id. */
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
        return decodeURIComponent(part.slice(eq + 1).trim());
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
export function serializeSessionCookie(sessionId: string, maxAgeSeconds = SESSION_TTL_SECONDS) {
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureAttribute()}`;
}

/** Build the `Set-Cookie` value that clears the session cookie. */
export function serializeClearedSessionCookie(): string {
    return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=${EXPIRED_COOKIE_DATE}${secureAttribute()}`;
}
