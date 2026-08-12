import { getDb } from '../_lib/db.js';
import { forgetSession } from '../_lib/auth.js';
import { readSessionCookie, serializeClearedSessionCookie } from '../../lib/auth/cookie.js';
import { destroySession } from '../../lib/auth/session.js';

async function handler(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response(null, { status: 405 });

    const sessionId = readSessionCookie(req);
    if (sessionId) {
        // Evict first: the cached lookup would otherwise keep the cookie working for
        // the rest of its TTL even after the row is gone.
        forgetSession(sessionId);

        // Best-effort server-side revocation; the cookie is cleared either way so a
        // DB hiccup can never leave the browser stuck in a "logged in" state.
        try {
            await destroySession(getDb(), sessionId);
        } catch (err) {
            console.error('[auth] session delete failed:', err);
        }
    }

    return Response.json(
        { success: true },
        { headers: { 'Set-Cookie': serializeClearedSessionCookie() } },
    );
}

export const POST = handler;
