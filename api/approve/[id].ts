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
    getConfigValue,
} from '../../lib/db/queries';
import { executeBuyOrder, executeSellOrder } from '../../lib/trading/order';
import { sendErrorEmail } from '../../lib/notification/email';

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

        const price = Number(order.priceLimit ?? 0);
        if (!Number.isFinite(price) || price <= 0) {
            return Response.json({ error: 'Order has no valid price limit' }, { status: 400 });
        }

        // Atomic status update — prevents concurrent approvals
        const updated = await approvePendingOrder(db, id);
        if (!updated) {
            return Response.json({ error: 'Order was already processed' }, { status: 409 });
        }

        // Check duplicate position for buy orders
        if (order.side === 'buy') {
            const existingPos = await getOpenPositionBySymbol(db, order.symbol);
            if (existingPos) {
                // Position already exists — record trade but don't open a duplicate position
                await insertTrade(db, {
                    symbol: order.symbol,
                    side: order.side,
                    orderType: 'market',
                    quantity: order.quantity,
                    price,
                    executedAt: new Date(),
                    reason: `${order.analysisSummary ?? '수동 승인'} (기존 포지션에 추가)`,
                    mode: 'semi_auto',
                });
                return Response.json({
                    success: true,
                    action,
                    id,
                    note: 'trade_recorded_position_exists',
                });
            }
        }

        // Determine trading mode and attempt real execution when applicable
        let filledPrice = price;
        const tradingMode = (await getConfigValue<string>(db, 'trading_mode')) ?? 'dry_run';

        if (tradingMode === 'auto') {
            try {
                const orderFn = order.side === 'buy' ? executeBuyOrder : executeSellOrder;
                const result = await orderFn(order.symbol, order.quantity);
                if (result.status === 'rejected') {
                    return Response.json(
                        { error: `Order rejected: ${result.message ?? 'unknown'}` },
                        { status: 422 },
                    );
                }
                if (result.status === 'filled' && result.filledPrice) {
                    filledPrice = result.filledPrice;
                }
            } catch {
                // Toss API unavailable — fall back to paper trade at priceLimit.
                // The order is already approved in DB so we proceed with paper execution.
            }
        }

        // Record trade (compensating: if this fails, order is approved but no
        // trade recorded — acceptable, visible in dashboard for manual recovery)
        try {
            await insertTrade(db, {
                symbol: order.symbol,
                side: order.side,
                orderType: 'market',
                quantity: order.quantity,
                price: filledPrice,
                executedAt: new Date(),
                reason: order.analysisSummary ?? '수동 승인',
                mode: tradingMode === 'auto' ? 'auto' : 'semi_auto',
            });

            // Update position
            if (order.side === 'buy') {
                await openPosition(db, {
                    symbol: order.symbol,
                    side: 'long',
                    quantity: order.quantity,
                    avgPrice: filledPrice,
                });
            } else if (order.side === 'sell') {
                const pos = await getOpenPositionBySymbol(db, order.symbol);
                if (pos) {
                    await closePosition(db, pos.id, filledPrice);
                }
            }
        } catch (err) {
            // Compensating: email alert about partial failure
            await sendErrorEmail(`승인 후 거래 기록 실패: ${order.symbol}`, String(err)).catch(
                () => {},
            );
            return Response.json(
                { error: 'Trade recording failed after approval' },
                { status: 500 },
            );
        }
    } else {
        const rejected = await rejectPendingOrder(db, id);
        if (!rejected) {
            return Response.json({ error: 'Order was already processed' }, { status: 409 });
        }
    }

    return Response.json({ success: true, action, id });
}
