import { getDb } from './_lib/db.js';
import { isAuthenticated } from './_lib/auth.js';
import { getLatestAnalysisResults, getAllLatestAnalysisResults } from '../lib/db/queries.js';

async function handler(req: Request): Promise<Response> {
    if (!(await isAuthenticated(req))) return new Response('Forbidden', { status: 403 });
    if (req.method !== 'GET') return new Response(null, { status: 405 });

    const url = new URL(req.url, 'http://localhost');
    const symbol = url.searchParams.get('symbol');

    const db = getDb();
    const results = symbol
        ? await getLatestAnalysisResults(db, symbol)
        : await getAllLatestAnalysisResults(db);

    return Response.json(results);
}

// Vercel Node runtime: expose Web `Request`/`Response` handlers via named HTTP-method
// exports. A bare `export default` would be treated as the legacy `(req, res)` handler.
export const GET = handler;
