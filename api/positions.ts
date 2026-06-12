import { getDb } from './_lib/db.js';
import { isAuthenticated } from './_lib/auth.js';
import { getOpenPositions } from '../lib/db/queries.js';

async function handler(req: Request): Promise<Response> {
    if (!isAuthenticated(req)) return new Response('Forbidden', { status: 403 });
    if (req.method !== 'GET') return new Response(null, { status: 405 });

    const db = getDb();
    const openPositions = await getOpenPositions(db);

    return Response.json(openPositions);
}

// Vercel Node runtime: expose Web `Request`/`Response` handlers via named HTTP-method
// exports. A bare `export default` would be treated as the legacy `(req, res)` handler.
export const GET = handler;
