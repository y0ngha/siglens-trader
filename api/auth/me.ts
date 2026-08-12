import { DEV_BYPASS_USER, getSessionUser, isAuthDisabled } from '../_lib/auth.js';

/**
 * Report the caller's login session.
 *
 * Session-only — a Cloudflare Access JWT alone is not an identity here, so the
 * dashboard still requires a login while Access is in front of the origin.
 *
 * The one exception is `DISABLE_AUTH=true` (non-production only): a local database
 * has no seeded operator, so without a stand-in user the SPA gate would pin every
 * developer to the login form with no way past it.
 */
async function handler(req: Request): Promise<Response> {
    if (req.method !== 'GET') return new Response(null, { status: 405 });

    const user = (await getSessionUser(req)) ?? (isAuthDisabled() ? DEV_BYPASS_USER : null);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    return Response.json({ user });
}

export const GET = handler;
