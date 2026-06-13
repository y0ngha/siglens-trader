import { isAuthenticated } from '../../_lib/auth.js';
import { getDb } from '../../_lib/db.js';
import { closePosition, getOpenPositions, insertTrade } from '../../../lib/db/queries.js';
import { realizedPnlForSell } from '../../../lib/strategy/pnl.js';

class AlreadyClosedError extends Error {
    constructor() {
        super('Position already closed');
        this.name = 'AlreadyClosedError';
    }
}

async function handler(req: Request): Promise<Response> {
    if (!(await isAuthenticated(req))) return new Response('Forbidden', { status: 403 });
    if (req.method !== 'POST') return new Response(null, { status: 405 });

    const url = new URL(req.url, 'http://localhost');
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

    // Accept optional price from request body; fall back to avgPrice
    const body = await req.json().catch(() => ({}));
    const requestedPrice = (body as Record<string, unknown>)?.price;
    const closePrice =
        typeof requestedPrice === 'number' && Number.isFinite(requestedPrice) && requestedPrice > 0
            ? requestedPrice
            : Number(position.avgPrice);

    // Close position + record trade atomically
    try {
        await db.transaction(async (tx) => {
            const closed = await closePosition(tx, id, closePrice);
            if (!closed) {
                throw new AlreadyClosedError();
            }
            await insertTrade(tx, {
                symbol: position.symbol,
                side: 'sell',
                orderType: 'market',
                quantity: position.quantity,
                price: closePrice,
                executedAt: new Date(),
                reason: '수동 청산',
                mode: 'semi_auto',
                realizedPnl: realizedPnlForSell(
                    closePrice,
                    Number(position.avgPrice),
                    position.quantity,
                ),
            });
        });
    } catch (err) {
        if (err instanceof AlreadyClosedError) {
            return Response.json({ error: 'Position already closed' }, { status: 409 });
        }
        throw err;
    }

    return Response.json({ success: true });
}

// Vercel Node runtime: expose Web `Request`/`Response` handlers via named HTTP-method
// exports. A bare `export default` would be treated as the legacy `(req, res)` handler.
export const POST = handler;
