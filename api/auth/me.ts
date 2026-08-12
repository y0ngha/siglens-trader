import { getSessionUser } from '../_lib/auth.js';

/**
 * Report the caller's login session. Deliberately session-only — a Cloudflare
 * Access JWT alone is not an identity here, so the dashboard still requires a
 * login while Access is in front of the origin.
 */
async function handler(req: Request): Promise<Response> {
    if (req.method !== 'GET') return new Response(null, { status: 405 });

    const user = await getSessionUser(req);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    return Response.json({ user });
}

export const GET = handler;
