import { getDb } from './_lib/db';
import { getOpenPositions } from '../lib/db/queries';

export default async function handler(req: Request): Promise<Response> {
    if (req.method !== 'GET') return new Response(null, { status: 405 });

    const db = getDb();
    const openPositions = await getOpenPositions(db);

    return Response.json(openPositions);
}
