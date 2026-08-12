import * as jose from 'jose';
import { readSessionCookie } from '../../lib/auth/cookie.js';
import { resolveSessionUser, type SessionUser } from '../../lib/auth/session.js';
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
 * Resolve the caller's own login session, or null when there is no valid one.
 *
 * This is the primary auth path. Cloudflare Access remains supported (see
 * {@link isAuthenticated}) but carries no identity of its own here, so handlers
 * that need to know *who* is calling must use this.
 */
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
    const sessionId = readSessionCookie(req);
    if (!sessionId) return null;

    try {
        return await resolveSessionUser(getDb(), sessionId);
    } catch (err) {
        // A DB outage must not read as a valid session → fail closed.
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
    if (process.env.DISABLE_AUTH === 'true' && !isProduction()) {
        return true;
    }

    if ((await getSessionUser(req)) !== null) return true;

    return hasValidAccessJwt(req);
}
