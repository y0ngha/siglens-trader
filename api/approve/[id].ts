import { getDb } from '../_lib/db';
import { isAuthenticated } from '../_lib/auth';
import {
    approvePendingOrder,
    rejectPendingOrder,
    getPendingOrderById,
    insertTrade,
    openPosition,
    getOpenPositionBySymbol,
    closePosition,
} from '../../lib/db/queries';

export default async function handler(req: Request): Promise<Response> {
    if (!isAuthenticated(req)) return new Response('Forbidden', { status: 403 });
    if (req.method !== 'POST') return new Response(null, { status: 405 });

    const url = new URL(req.url);
    const idStr = url.pathname.split('/').pop();
    const id = Number(idStr);

    if (!idStr || Number.isNaN(id)) {
        return Response.json({ error: 'Invalid order ID' }, { status: 400 });
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body || typeof body !== 'object' || !('action' in body)) {
        return Response.json({ error: 'Missing "action" field' }, { status: 400 });
    }

    const { action } = body as { action: string };

    if (action !== 'approve' && action !== 'reject') {
        return Response.json({ error: 'Action must be "approve" or "reject"' }, { status: 400 });
    }

    const db = getDb();

    if (action === 'approve') {
        const order = await getPendingOrderById(db, id);
        if (!order) {
            return Response.json({ error: 'Order not found' }, { status: 404 });
        }
        if (order.status !== 'pending') {
            return Response.json({ error: 'Order is no longer pending' }, { status: 409 });
        }
        if (new Date(order.expiresAt) < new Date()) {
            return Response.json({ error: 'Order has expired' }, { status: 410 });
        }

        await approvePendingOrder(db, id);

        // Execute the trade
        const price = Number(order.priceLimit ?? 0);
        await insertTrade(db, {
            symbol: order.symbol,
            side: order.side,
            orderType: 'market',
            quantity: order.quantity,
            price,
            executedAt: new Date(),
            reason: order.analysisSummary ?? '수동 승인',
            mode: 'semi_auto',
        });

        // Update position
        if (order.side === 'buy') {
            await openPosition(db, {
                symbol: order.symbol,
                side: 'long',
                quantity: order.quantity,
                avgPrice: price,
            });
        } else if (order.side === 'sell') {
            const pos = await getOpenPositionBySymbol(db, order.symbol);
            if (pos) {
                await closePosition(db, pos.id, price);
            }
        }
    } else {
        await rejectPendingOrder(db, id);
    }

    return Response.json({ success: true, action, id });
}
