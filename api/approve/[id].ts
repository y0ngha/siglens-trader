import { getDb } from '../_lib/db.js';
import { isAuthenticated } from '../_lib/auth.js';
import {
    approvePendingOrder,
    revertPendingOrder,
    rejectPendingOrder,
    getPendingOrderById,
    insertTrade,
    openPosition,
    getOpenPositionBySymbol,
    closePosition,
    reducePositionQuantity,
    getConfigValue,
    createOrderTracking,
    updateOrderTracking,
    averageIntoPosition,
} from '../../lib/db/queries.js';
import { executeBuyOrder, executeSellOrder } from '../../lib/trading/orders.js';
import { sendErrorEmail } from '../../lib/notification/email.js';
import { realizedPnlForSell } from '../../lib/strategy/pnl.js';

export default async function handler(req: Request): Promise<Response> {
    if (!isAuthenticated(req)) return new Response('Forbidden', { status: 403 });
    if (req.method !== 'POST') return new Response(null, { status: 405 });

    const url = new URL(req.url, 'http://localhost');
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

        // Facade-order idempotency key (== Toss clientOrderId) for the auto path.
        // Threaded onto the booked trade so reconcile can match by client_order_id.
        // Only meaningful in 'auto' mode (a real Toss order was placed); undefined otherwise.
        const idempotencyKey = `approve-${id}`;
        const bookingClientOrderId = tradingMode === 'auto' ? idempotencyKey : undefined;

        if (tradingMode === 'auto') {
            try {
                await createOrderTracking(db, {
                    idempotencyKey,
                    clientOrderId: idempotencyKey,
                    symbol: order.symbol,
                    side: order.side,
                    quantity: order.quantity,
                    status: 'submitted',
                });

                const orderFn = order.side === 'buy' ? executeBuyOrder : executeSellOrder;
                const result = await orderFn(order.symbol, order.quantity, idempotencyKey);

                await updateOrderTracking(db, idempotencyKey, {
                    tossOrderId: result.orderId || undefined,
                    status: result.status,
                    filledPrice: result.avgFilledPrice ?? undefined,
                    resolvedAt:
                        result.status === 'pending' || result.status === 'partial'
                            ? undefined
                            : new Date(),
                });

                if (result.status === 'rejected' || result.status === 'canceled') {
                    await revertPendingOrder(db, id).catch(() => {});
                    return Response.json(
                        { error: `Order ${result.status}: ${result.rejectReason ?? 'unknown'}` },
                        { status: 422 },
                    );
                }
                if (result.status === 'pending' || result.status === 'partial') {
                    // 접수됐으나 미확정 — 거래는 reconcile cron이 확정/기록. 여기서는 기록하지 않음.
                    const msg =
                        result.status === 'partial'
                            ? `주문이 부분 체결되었습니다 (${result.filledQuantity ?? '?'}주). 나머지 체결/확정은 reconcile가 처리합니다.`
                            : '주문이 접수되었으나 아직 체결되지 않았습니다. reconcile가 확정합니다.';
                    return Response.json(
                        { accepted: true, status: result.status, message: msg },
                        { status: 202 },
                    );
                }
                // result.status === 'filled' — only auto-book a clean full fill.
                // If NOT clean (null price, fractional qty, or short fill) → needs_review + alert.
                const filledQ = result.filledQuantity ?? order.quantity;
                const cleanFullFill =
                    result.avgFilledPrice != null &&
                    Number.isInteger(order.quantity) &&
                    Math.abs(filledQ - order.quantity) < 1e-6;
                if (!cleanFullFill) {
                    await updateOrderTracking(db, idempotencyKey, {
                        status: 'needs_review',
                        filledPrice: result.avgFilledPrice ?? undefined,
                        resolvedAt: new Date(),
                    });
                    await sendErrorEmail(
                        `체결 수동확인 필요: ${order.symbol}`,
                        `${order.symbol} 주문이 예상과 다르게 체결됨 (의도 ${order.quantity}주, 체결 ${filledQ}, 체결가 ${result.avgFilledPrice ?? '없음'}). 수동 기록 필요.`,
                    ).catch((e) => console.error('[email]', e));
                    return Response.json(
                        {
                            accepted: true,
                            status: 'needs_review',
                            message: '체결이 예상과 달라 수동 확인이 필요합니다.',
                        },
                        { status: 202 },
                    );
                }
                filledPrice = result.avgFilledPrice!; // non-null: cleanFullFill requires avgFilledPrice != null
                actualQuantity = order.quantity; // integer, == filledQ
            } catch (err) {
                // Toss API failed — mark order tracking as error and revert pending status
                await updateOrderTracking(db, idempotencyKey, {
                    status: 'error',
                    resolvedAt: new Date(),
                }).catch(() => {});
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
                        clientOrderId: bookingClientOrderId,
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
                if (!pos) {
                    // No position to sell — record trade but warn
                    await insertTrade(db, {
                        symbol: order.symbol,
                        side: 'sell',
                        orderType: 'market',
                        quantity: actualQuantity,
                        price: filledPrice,
                        executedAt: new Date(),
                        reason: `${order.analysisSummary ?? '수동 승인'} (포지션 미확인 — 수동 확인 필요)`,
                        mode: tradingMode === 'auto' ? 'auto' : 'semi_auto',
                        clientOrderId: bookingClientOrderId,
                    });
                    await sendErrorEmail(
                        `포지션 미확인 매도: ${order.symbol}`,
                        `${order.symbol} 매도가 승인되었으나 DB에 해당 포지션이 없습니다. 수동 확인이 필요합니다.`,
                    ).catch((e) => console.error('[email]', e));
                } else if (actualQuantity >= pos.quantity) {
                    // Full close
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
                            clientOrderId: bookingClientOrderId,
                            realizedPnl: realizedPnlForSell(
                                filledPrice,
                                Number(pos.avgPrice),
                                actualQuantity,
                            ),
                        });
                    });
                } else {
                    // Partial close
                    await db.transaction(async (tx) => {
                        await reducePositionQuantity(tx, pos.id, actualQuantity);
                        await insertTrade(tx, {
                            symbol: order.symbol,
                            side: order.side,
                            orderType: 'market',
                            quantity: actualQuantity,
                            price: filledPrice,
                            executedAt: new Date(),
                            reason: `${order.analysisSummary ?? '수동 승인'} (부분 매도)`,
                            mode: tradingMode === 'auto' ? 'auto' : 'semi_auto',
                            clientOrderId: bookingClientOrderId,
                            realizedPnl: realizedPnlForSell(
                                filledPrice,
                                Number(pos.avgPrice),
                                actualQuantity,
                            ),
                        });
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
                    clientOrderId: bookingClientOrderId,
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
