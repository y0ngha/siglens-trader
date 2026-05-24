import { isAuthenticated } from '../../_lib/auth';
import { getDb } from '../../_lib/db';
import { closePosition, getOpenPositions, insertTrade } from '../../../lib/db/queries';

export default async function handler(req: Request): Promise<Response> {
    if (!isAuthenticated(req)) return new Response('Forbidden', { status: 403 });
    if (req.method !== 'POST') return new Response(null, { status: 405 });

    const url = new URL(req.url);
    const segments = url.pathname.split('/');
    // URL: /api/positions/:id/close -> segments = ['', 'api', 'positions', ':id', 'close']
    const id = Number(segments[segments.length - 2]);

    if (Number.isNaN(id)) {
        return Response.json({ error: 'Invalid position ID' }, { status: 400 });
    }

    const db = getDb();

    // Find the position to get details for the trade record
    const positions = await getOpenPositions(db);
    const position = positions.find((p) => p.id === id);

    if (!position) {
        return Response.json({ error: 'Position not found' }, { status: 404 });
    }

    // Atomically close — returns false if already closed (race condition guard)
    const closePrice = Number(position.avgPrice);
    const closed = await closePosition(db, id, closePrice);
    if (!closed) {
        return Response.json({ error: 'Position already closed' }, { status: 409 });
    }

    // Record the trade
    await insertTrade(db, {
        symbol: position.symbol,
        side: 'sell',
        orderType: 'market',
        quantity: position.quantity,
        price: closePrice,
        executedAt: new Date(),
        reason: '수동 청산',
        mode: 'semi_auto',
    });

    return Response.json({ success: true });
}
