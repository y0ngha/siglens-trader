import { getDb } from '../_lib/db';
import { isAuthenticated } from '../_lib/auth';
import {
    approvePendingOrder,
    revertPendingOrder,
    rejectPendingOrder,
    getPendingOrderById,
    insertTrade,
    openPosition,
    getOpenPositionBySymbol,
    closePosition,
    getConfigValue,
    createOrderTracking,
    updateOrderTracking,
    averageIntoPosition,
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

        // Determine trading mode and attempt real execution when applicable
        let filledPrice = price;
        let actualQuantity = order.quantity;
        const tradingMode = (await getConfigValue<string>(db, 'trading_mode')) ?? 'dry_run';

        if (tradingMode === 'auto') {
            try {
                const idempotencyKey = `approve-${id}`;
                await createOrderTracking(db, {
                    idempotencyKey,
                    symbol: order.symbol,
                    side: order.side,
                    quantity: order.quantity,
                    status: 'submitted',
                });

                const orderFn = order.side === 'buy' ? executeBuyOrder : executeSellOrder;
                const result = await orderFn(order.symbol, order.quantity, idempotencyKey);

                await updateOrderTracking(db, idempotencyKey, {
                    tossOrderId: result.orderId,
                    status: result.status,
                    filledPrice: result.filledPrice ?? undefined,
                    resolvedAt: result.status !== 'submitted' ? new Date() : undefined,
                });

                if (result.status === 'rejected') {
                    return Response.json(
                        { error: `Order rejected: ${result.message ?? 'unknown'}` },
                        { status: 422 },
                    );
                }
                if (result.status === 'submitted') {
                    return Response.json(
                        {
                            accepted: true,
                            status: 'submitted',
                            message:
                                '주문이 접수되었으나 아직 체결되지 않았습니다. 추후 확인이 필요합니다.',
                        },
                        { status: 202 },
                    );
                }
                if (result.status === 'filled') {
                    if (!result.filledPrice) {
                        await updateOrderTracking(db, idempotencyKey, {
                            status: 'fill_price_unknown',
                        });
                        await sendErrorEmail(
                            `체결가 누락: ${order.symbol}`,
                            `${order.symbol} 주문이 체결되었으나 체결가가 반환되지 않았습니다. 수동 확인이 필요합니다.`,
                        ).catch((e) => console.error('[email]', e));
                        return Response.json(
                            {
                                error: 'Order filled but no fill price returned — manual reconciliation needed',
                            },
                            { status: 502 },
                        );
                    }
                    filledPrice = result.filledPrice;
                    actualQuantity = result.filledQuantity ?? order.quantity;
                }
            } catch (err) {
                // Toss API failed — revert order status back to pending so user can retry
                await revertPendingOrder(db, id).catch(() => {});

                await sendErrorEmail(
                    `주문 실행 실패: ${order.symbol}`,
                    `승인된 주문의 실제 실행에 실패했습니다. 재시도하거나 수동으로 처리해주세요.\n오류: ${String(err)}`,
                ).catch((e) => console.error('[email] send failed:', e));
                return Response.json(
                    {
                        error: 'Toss API 주문 실행 실패. 거래가 기록되지 않았습니다.',
                        detail: String(err),
                    },
                    { status: 502 },
                );
            }
        }

        // Record trade + update position atomically.
        // If either fails, both are rolled back — no orphan trade records.
        try {
            if (order.side === 'buy') {
                const existingPos = await getOpenPositionBySymbol(db, order.symbol);
                await db.transaction(async (tx) => {
                    await insertTrade(tx, {
                        symbol: order.symbol,
                        side: order.side,
                        orderType: 'market',
                        quantity: actualQuantity,
                        price: filledPrice,
                        executedAt: new Date(),
                        reason: existingPos
                            ? `${order.analysisSummary ?? '수동 승인'} (기존 포지션에 추가)`
                            : (order.analysisSummary ?? '수동 승인'),
                        mode: tradingMode === 'auto' ? 'auto' : 'semi_auto',
                    });
                    if (existingPos) {
                        await averageIntoPosition(tx, existingPos.id, actualQuantity, filledPrice);
                    } else {
                        await openPosition(tx, {
                            symbol: order.symbol,
                            side: 'long',
                            quantity: actualQuantity,
                            avgPrice: filledPrice,
                        });
                    }
                });
            } else if (order.side === 'sell') {
                const pos = await getOpenPositionBySymbol(db, order.symbol);
                if (pos) {
                    await db.transaction(async (tx) => {
                        const closed = await closePosition(tx, pos.id, filledPrice);
                        if (!closed) throw new Error('POSITION_ALREADY_CLOSED');
                        await insertTrade(tx, {
                            symbol: order.symbol,
                            side: order.side,
                            orderType: 'market',
                            quantity: actualQuantity,
                            price: filledPrice,
                            executedAt: new Date(),
                            reason: order.analysisSummary ?? '수동 승인',
                            mode: tradingMode === 'auto' ? 'auto' : 'semi_auto',
                        });
                    });
                } else {
                    await insertTrade(db, {
                        symbol: order.symbol,
                        side: order.side,
                        orderType: 'market',
                        quantity: actualQuantity,
                        price: filledPrice,
                        executedAt: new Date(),
                        reason: order.analysisSummary ?? '수동 승인',
                        mode: tradingMode === 'auto' ? 'auto' : 'semi_auto',
                    });
                }
            } else {
                await insertTrade(db, {
                    symbol: order.symbol,
                    side: order.side,
                    orderType: 'market',
                    quantity: actualQuantity,
                    price: filledPrice,
                    executedAt: new Date(),
                    reason: order.analysisSummary ?? '수동 승인',
                    mode: tradingMode === 'auto' ? 'auto' : 'semi_auto',
                });
            }
        } catch (err) {
            if (err instanceof Error && err.message === 'POSITION_ALREADY_CLOSED') {
                return Response.json({
                    success: true,
                    action,
                    id,
                    note: 'position_already_closed',
                });
            }
            // Transaction rolled back — revert order status so user can retry
            await revertPendingOrder(db, id).catch(() => {});
            // Email alert about failure
            await sendErrorEmail(`승인 후 거래 기록 실패: ${order.symbol}`, String(err)).catch(
                (emailErr) => console.error('[email] send failed:', emailErr),
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
