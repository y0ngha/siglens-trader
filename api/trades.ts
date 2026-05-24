import { getDb } from './_lib/db';
import { getRecentTrades } from '../lib/db/queries';

export default async function handler(req: Request): Promise<Response> {
    if (req.method !== 'GET') return new Response(null, { status: 405 });

    const db = getDb();
    const trades = await getRecentTrades(db, 100);

    return Response.json(trades);
}
