import { getDb } from './_lib/db';
import { isAuthenticated } from './_lib/auth';
import { getLatestAnalysisResults } from '../lib/db/queries';

export default async function handler(req: Request): Promise<Response> {
    if (!isAuthenticated(req)) return new Response('Forbidden', { status: 403 });
    if (req.method !== 'GET') return new Response(null, { status: 405 });

    const url = new URL(req.url);
    const symbol = url.searchParams.get('symbol');

    if (!symbol) {
        return Response.json([]);
    }

    const db = getDb();
    const results = await getLatestAnalysisResults(db, symbol);

    return Response.json(results);
}
