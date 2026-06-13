import * as jose from 'jose';

// Cache the JWKS set at module scope so it is not recreated per request.
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

export async function isAuthenticated(req: Request): Promise<boolean> {
    // -----------------------------------------------------------------------
    // Local dev escape hatch — DISABLE_AUTH is silently ignored in production.
    // -----------------------------------------------------------------------
    if (process.env.DISABLE_AUTH === 'true' && !isProduction()) {
        return true;
    }

    const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
    const audience = process.env.CF_ACCESS_AUD;

    // -----------------------------------------------------------------------
    // JWT verification path — active when CF Access env vars are configured.
    // -----------------------------------------------------------------------
    if (teamDomain && audience) {
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
        } catch {
            // Verification failure (expired, tampered, JWKS fetch error, etc.) → fail-closed.
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // Fallback (env NOT configured) — trust the plain header.
    // Weaker mode, but prevents a production lockout before env vars are set.
    // -----------------------------------------------------------------------
    console.warn(
        '[auth] CF Access JWT verification not configured; falling back to header trust — set CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD',
    );
    const cfEmail = req.headers.get('cf-access-authenticated-user-email');
    return Boolean(cfEmail);
}
