import { getDb } from './_lib/db.js';
import { isAuthenticated } from './_lib/auth.js';
import { getRecentTrades, dismissTrade } from '../lib/db/queries.js';

export default async function handler(req: Request): Promise<Response> {
    if (!isAuthenticated(req)) return new Response('Forbidden', { status: 403 });

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
