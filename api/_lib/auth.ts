import * as jose from 'jose';
import { readSessionCookie } from '../../lib/auth/cookie.js';
import { isSessionId, resolveSessionUser, type SessionUser } from '../../lib/auth/session.js';
import { getDb } from './db.js';

// Cache the JWKS set at module scope so it is not recreated per request.
// Assumption: CF_ACCESS_TEAM_DOMAIN is fixed for the lifetime of the process,
// so keying the cache on teamDomain is unnecessary — a single cached instance suffices.
let jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

function getJwks(teamDomain: string): ReturnType<typeof jose.createRemoteJWKSet> {
    if (!jwks) {
        jwks = jose.createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    }
    return jwks;
}

function isProduction(): boolean {
    if (process.env.VERCEL_ENV) {
        return process.env.VERCEL_ENV === 'production';
    }
    return process.env.NODE_ENV === 'production';
}

/**
 * Short-lived session cache.
 *
 * The dashboard polls several endpoints every 10 seconds and each one resolves the
 * cookie, so without this every poll adds a cross-region round trip to Neon. A few
 * seconds of staleness is the cost: a logout invalidates its own entry immediately
 * (see {@link forgetSession}), and a session revoked out-of-process — the password
 * rotation in `db:seed-operator` — takes at most one TTL to be noticed.
 */
const SESSION_CACHE_TTL_MS = 5_000;

/** Cap on cached lookups — junk cookies must not be able to grow the map without bound. */
const SESSION_CACHE_MAX_ENTRIES = 1_000;

const sessionCache = new Map<string, { user: SessionUser | null; expiresAt: number }>();

/** Drop expired entries; if that is not enough, drop oldest-first (Map preserves insertion order). */
function pruneSessionCache(now: number): void {
    for (const [id, entry] of sessionCache) {
        if (entry.expiresAt <= now) sessionCache.delete(id);
    }
    while (sessionCache.size >= SESSION_CACHE_MAX_ENTRIES) {
        const oldest = sessionCache.keys().next();
        if (oldest.done) break;
        sessionCache.delete(oldest.value);
    }
}

/** Drop a session's cached lookup — called on logout so the cookie dies at once. */
export function forgetSession(sessionId: string): void {
    sessionCache.delete(sessionId);
}

/** Test seam — empties the cache. */
export function resetSessionCache(): void {
    sessionCache.clear();
}

/**
 * A stand-in identity for `DISABLE_AUTH=true` local development.
 *
 * `getSessionUser` deliberately does not honour DISABLE_AUTH — an identity must come
 * from a real session — but the dashboard gate needs *someone* to render, and a local
 * database has no seeded operator. The id is not a uuid, so it can never collide with
 * a real row, and the flag is inert in production.
 */
export const DEV_BYPASS_USER: SessionUser = {
    id: 'disable-auth-dev',
    email: 'dev@localhost',
    name: 'DISABLE_AUTH',
};

/** True when the local auth bypass is active (never in production). */
export function isAuthDisabled(): boolean {
    return process.env.DISABLE_AUTH === 'true' && !isProduction();
}

/**
 * Resolve the caller's own login session, or null when there is no valid one.
 *
 * This is the primary auth path. Cloudflare Access remains supported (see
 * {@link isAuthenticated}) but carries no identity of its own here, so handlers
 * that need to know *who* is calling must use this.
 */
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
    const sessionId = readSessionCookie(req);
    if (!sessionId) return null;

    // Reject the shape before the cache, not just before the query. A malformed value
    // can never match a session, so caching it buys nothing — and an unauthenticated
    // client streaming distinct junk cookies would otherwise fill the map and evict the
    // operator's real entry.
    if (!isSessionId(sessionId)) return null;

    const now = Date.now();
    const cached = sessionCache.get(sessionId);
    if (cached && cached.expiresAt > now) return cached.user;

    try {
        const user = await resolveSessionUser(getDb(), sessionId);
        // Misses are cached too: a well-formed uuid that matches no row would otherwise
        // hit the database on every request.
        if (sessionCache.size >= SESSION_CACHE_MAX_ENTRIES) pruneSessionCache(now);
        sessionCache.set(sessionId, { user, expiresAt: now + SESSION_CACHE_TTL_MS });
        return user;
    } catch (err) {
        // A DB outage must not read as a valid session → fail closed, and do not cache
        // the failure: the next request should retry rather than inherit the outage.
        console.error('[auth] session lookup failed:', err);
        return null;
    }
}

/**
 * Verify a Cloudflare Access JWT.
 *
 * Retained so the site keeps working while Access is still in front of it; once
 * Access is turned off no request carries the assertion and this simply returns
 * false, leaving the session cookie as the only way in. There is deliberately no
 * "trust the `cf-access-authenticated-user-email` header" fallback: with the origin
 * reachable without Access, any client could forge that header and bypass login.
 */
async function hasValidAccessJwt(req: Request): Promise<boolean> {
    const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
    const audience = process.env.CF_ACCESS_AUD;
    if (!teamDomain || !audience) return false;

    const assertion = req.headers.get('Cf-Access-Jwt-Assertion');
    if (!assertion) return false;

    try {
        const { payload } = await jose.jwtVerify(assertion, getJwks(teamDomain), {
            issuer: teamDomain,
            audience,
        });

        const allowedEmails = process.env.CF_ACCESS_ALLOWED_EMAILS;
        if (allowedEmails) {
            const allowed = allowedEmails.split(',').map((e) => e.trim());
            const email = typeof payload.email === 'string' ? payload.email : null;
            if (!email || !allowed.includes(email)) return false;
        }

        return true;
    } catch (err) {
        // Verification failure (expired, tampered, JWKS fetch error, etc.) → fail-closed.
        console.error('[auth] JWT verification failed:', err);
        return false;
    }
}

export async function isAuthenticated(req: Request): Promise<boolean> {
    // Local dev escape hatch — DISABLE_AUTH is silently ignored in production.
    if (isAuthDisabled()) return true;

    if ((await getSessionUser(req)) !== null) return true;

    return hasValidAccessJwt(req);
}
