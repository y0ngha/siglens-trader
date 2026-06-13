import { getDb } from './_lib/db.js';
import { isAuthenticated } from './_lib/auth.js';
import { getRecentTrades, dismissTrade } from '../lib/db/queries.js';

async function handler(req: Request): Promise<Response> {
    if (!(await isAuthenticated(req))) return new Response('Forbidden', { status: 403 });

    const db = getDb();

    if (req.method === 'GET') {
        const trades = await getRecentTrades(db, 100);
        return Response.json(trades);
    }

    if (req.method === 'POST') {
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return Response.json({ error: 'Invalid JSON' }, { status: 400 });
        }

        const parsed = body as Record<string, unknown>;
        if (parsed.action === 'dismiss' && typeof parsed.id === 'number') {
            await dismissTrade(db, parsed.id);
            return Response.json({ success: true });
        }

        return Response.json({ error: 'Invalid action' }, { status: 400 });
    }

    return new Response(null, { status: 405 });
}

// Vercel Node runtime: expose Web `Request`/`Response` handlers via named HTTP-method
// exports. A bare `export default` would be treated as the legacy `(req, res)` handler.
export const GET = handler;
export const POST = handler;
