import { getDb } from './_lib/db.js';
import { isAuthenticated } from './_lib/auth.js';
import { getPendingOrders } from '../lib/db/queries.js';

export default async function handler(req: Request): Promise<Response> {
    if (!isAuthenticated(req)) return new Response('Forbidden', { status: 403 });
    if (req.method !== 'GET') return new Response(null, { status: 405 });

    const db = getDb();
    const pendingOrders = await getPendingOrders(db);

    return Response.json(pendingOrders);
}
