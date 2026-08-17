import { getDb } from '../_lib/db.js';
import { isFinitePositive } from '../../lib/validation.js';
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
    getNotificationConfig,
    enqueueNotification,
    createOrderTracking,
    updateOrderTracking,
    averageIntoPosition,
    getTodayInflightOrderCount,
    getTodayRealizedPnl,
    getTodayTradeCount,
} from '../../lib/db/queries.js';
import { executeBuyOrder, executeSellOrder } from '../../lib/trading/orders.js';
import { getSellableQuantity } from '../../lib/trading/account.js';
import { makeEmailGate } from '../../lib/notification/gate.js';
import { createEmailDispatcher } from '../../lib/notification/dispatch.js';
import { realizedPnlForSell } from '../../lib/strategy/pnl.js';

async function handler(req: Request): Promise<Response> {
    if (!(await isAuthenticated(req))) return new Response('Forbidden', { status: 403 });
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

    // A3: gate all notifications (error + trade-executed) on the master toggle.
    // A2: thread the configured recipient so the dashboard target is honoured.
    const emailNotif = (await getNotificationConfig(db)).find((n) => n.channel === 'email');
    const dispatcher = createEmailDispatcher({
        gate: makeEmailGate(emailNotif),
        to: emailNotif?.target,
        enqueue: (row) => enqueueNotification(db, row),
    });

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

        // Kill switch: refuse execution if trading has been disabled since the order was queued.
        // Checked after the atomic approvePendingOrder to prevent the order from being lost —
        // if trading is disabled, we revert to 'pending' so the user can re-approve later.
        const tradingEnabled = (await getConfigValue<boolean>(db, 'trading_enabled')) ?? true;
        if (!tradingEnabled) {
            await revertPendingOrder(db, id).catch((err) =>
                console.error(`[approve] Failed to revert pending order ${id}:`, err),
            );
            return Response.json({ error: 'trading is disabled (kill switch)' }, { status: 409 });
        }

        // 리스크 회로차단기 재확인 — 매수 승인에 한해서.
        //
        // 종전에는 킬 스위치 하나만 다시 봤다. 대기 주문은 큐잉된 뒤 승인까지 최대 15분이
        // 비는데, 그 사이 일일 손실 한도가 터져 전 종목이 강제청산됐어도 승인 버튼은 그대로
        // 신규 진입을 체결시켰다. `CLAUDE.md`가 면제한다고 명시한 것은 **진입 시간 창**뿐이고
        // (운영자가 명시적으로 누른 승인을 시간으로 되돌리는 쪽이 더 혼란스럽다는 이유),
        // 손실·체결 한도는 원칙 7이 말하는 리스크 차단기라 같은 면제 대상이 아니다.
        // 매도 승인은 리스크를 줄이는 방향이므로 막지 않는다.
        if (order.side === 'buy') {
            const approveMode = (await getConfigValue<string>(db, 'trading_mode')) ?? 'dry_run';
            const [maxDailyLoss, todayPnl, maxTradesPerDay, tradeCount, inflightCount] =
                await Promise.all([
                    getConfigValue<number>(db, 'max_daily_loss_usd'),
                    getTodayRealizedPnl(db, approveMode),
                    getConfigValue<number>(db, 'max_trades_per_day'),
                    getTodayTradeCount(db),
                    getTodayInflightOrderCount(db),
                ]);
            const lossLimit = maxDailyLoss ?? 500;
            const tradeLimit = maxTradesPerDay ?? 20;
            const blocked =
                todayPnl < -lossLimit
                    ? `일일 손실 한도 초과 (실현 $${todayPnl.toFixed(2)} / 한도 $${lossLimit})`
                    : tradeCount + inflightCount >= tradeLimit
                      ? `일일 거래 한도 도달 (${tradeCount + inflightCount}/${tradeLimit})`
                      : null;
            if (blocked) {
                await revertPendingOrder(db, id).catch((err) =>
                    console.error(`[approve] Failed to revert pending order ${id}:`, err),
                );
                return Response.json({ error: blocked }, { status: 409 });
            }
        }

        // Determine trading mode and attempt real execution when applicable.
        // dry_run keeps the existing simulated approval behavior; semi_auto and auto both
        // place a real Toss order after explicit user approval.
        let filledPrice = price;
        let actualQuantity = order.quantity;
        const tradingMode = (await getConfigValue<string>(db, 'trading_mode')) ?? 'dry_run';
        const shouldPlaceLiveOrder = tradingMode === 'semi_auto' || tradingMode === 'auto';

        // Facade-order idempotency key (== Toss clientOrderId) for the auto path.
        // Threaded onto the booked trade so reconcile can match by client_order_id.
        // Only meaningful when a real Toss order was placed; undefined otherwise.
        const idempotencyKey = `approve-${id}`;
        const bookingClientOrderId = shouldPlaceLiveOrder ? idempotencyKey : undefined;
        let filledTossOrderId: string | undefined;
        // 실제 모드를 기록한다. 종전 `shouldPlaceLiveOrder ? tradingMode : 'semi_auto'`는
        // dry_run에서 누른 승인까지 `semi_auto`로 남겨, 시뮬레이션 손익이
        // `getTodayRealizedPnl`(mode NOT IN ('skipped','dry_run'))에 섞여 **실계좌 손실
        // 차단기**를 오염시켰다. `positions/[id]/close.ts`에서 이미 고친 것과 같은 버그.
        const bookedMode = tradingMode;

        const markFilledInTracking = async (tx: Parameters<typeof updateOrderTracking>[0]) => {
            if (!shouldPlaceLiveOrder) return;
            await updateOrderTracking(tx, idempotencyKey, {
                tossOrderId: filledTossOrderId,
                status: 'filled',
                filledPrice,
                resolvedAt: new Date(),
            });
        };

        if (shouldPlaceLiveOrder) {
            try {
                // 매도는 브로커 보유 수량으로 클램프한다. 대기 주문은 큐잉 후 승인까지 최대
                // 15분이 비는데, 그 사이 execute의 재평가 루프가 같은 포지션을 부분 청산했으면
                // 승인된 수량이 실제 보유를 넘는다. execute의 두 매도 경로와 같은 가드.
                if (order.side === 'sell') {
                    const sellable = await getSellableQuantity(order.symbol).catch(() => null);
                    if (sellable != null) {
                        const clamped = Math.min(actualQuantity, Math.floor(sellable));
                        if (clamped <= 0) {
                            // 주문을 내기 **전**이라 결말이 확정돼 있다(아무것도 안 나갔다).
                            // 되살리지 않으면 `approved` 상태로 고착돼 재승인도
                            // (`status !== 'pending'` 409) 만료도(`expireOldPendingOrders`는
                            // `pending`만 본다) 불가능해진다. 킬 스위치·한도 분기와 같은 처리.
                            await revertPendingOrder(db, id).catch((err) =>
                                console.error(
                                    `[approve] Failed to revert pending order ${id}:`,
                                    err,
                                ),
                            );
                            return Response.json(
                                {
                                    error: `${order.symbol} 매도 가능 수량이 없습니다 (브로커 보유 ${sellable}).`,
                                },
                                { status: 422 },
                            );
                        }
                        actualQuantity = clamped;
                    }
                }

                await createOrderTracking(db, {
                    idempotencyKey,
                    clientOrderId: idempotencyKey,
                    symbol: order.symbol,
                    side: order.side,
                    quantity: actualQuantity,
                    status: 'submitted',
                });

                const orderFn = order.side === 'buy' ? executeBuyOrder : executeSellOrder;
                const result = await orderFn(order.symbol, actualQuantity, idempotencyKey);

                if (result.status === 'rejected' || result.status === 'canceled') {
                    await updateOrderTracking(db, idempotencyKey, {
                        tossOrderId: result.orderId || undefined,
                        status: result.status,
                        filledPrice: result.avgFilledPrice ?? undefined,
                        resolvedAt: new Date(),
                    });
                    await revertPendingOrder(db, id).catch(() => {});
                    return Response.json(
                        { error: `Order ${result.status}: ${result.rejectReason ?? 'unknown'}` },
                        { status: 422 },
                    );
                }
                if (result.status === 'pending' || result.status === 'partial') {
                    await updateOrderTracking(db, idempotencyKey, {
                        tossOrderId: result.orderId || undefined,
                        status: result.status,
                        filledPrice: result.avgFilledPrice ?? undefined,
                        resolvedAt: undefined,
                    });
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
                const filledQ = result.filledQuantity ?? actualQuantity;
                const cleanFullFill =
                    // 0을 통과시키면 체결가 0으로 기록되어 실현 손익이 왜곡된다.
                    isFinitePositive(result.avgFilledPrice) &&
                    Number.isInteger(actualQuantity) &&
                    Math.abs(filledQ - actualQuantity) < 1e-6;
                if (!cleanFullFill) {
                    await updateOrderTracking(db, idempotencyKey, {
                        status: 'needs_review',
                        filledPrice: result.avgFilledPrice ?? undefined,
                        resolvedAt: new Date(),
                    });
                    await dispatcher
                        .notifyError(
                            `체결 수동확인 필요: ${order.symbol}`,
                            `${order.symbol} 주문이 예상과 다르게 체결됨 (의도 ${actualQuantity}주, 체결 ${filledQ}, 체결가 ${result.avgFilledPrice ?? '없음'}). 수동 기록 필요.`,
                        )
                        .catch((e) => console.error('[email]', e));
                    return Response.json(
                        {
                            accepted: true,
                            status: 'needs_review',
                            message: '체결이 예상과 달라 수동 확인이 필요합니다.',
                        },
                        { status: 202 },
                    );
                }
                filledPrice = result.avgFilledPrice!; // cleanFullFill이 유한 양수를 보장한다
                filledTossOrderId = result.orderId || undefined;
            } catch (err) {
                // 예외는 "주문이 나가지 않았다"가 아니라 **결말을 모른다**는 뜻이다
                // (타임아웃·5xx·멱등키 충돌은 브로커가 이미 주문을 갖고 있다는 신호에 가깝다).
                // 그래서 `error`(= in-flight)로 남기고 **대기 주문을 되살리지 않는다.**
                // 되살리면 운영자가 재승인할 수 있는데, 토스 멱등키 유효기간은 10분이라
                // 그 뒤의 재승인은 같은 키가 새 주문으로 처리되어 **실주문 2건**이 된다.
                // 확정은 reconcile이 브로커에 물어서 한다.
                await updateOrderTracking(db, idempotencyKey, {
                    status: 'error',
                    resolvedAt: new Date(),
                }).catch(() => {});

                await dispatcher
                    .notifyError(
                        `주문 결과 미확정: ${order.symbol}`,
                        `승인된 주문의 실행 결과를 확인하지 못했습니다. **브로커에 주문이 남아 있을 수 있으므로 재승인하지 마세요.** reconcile이 확정하며, 그 전에 브로커 계좌를 직접 확인하세요.\n오류: ${String(err)}`,
                    )
                    .catch((e) => console.error('[email] send failed:', e));
                return Response.json(
                    {
                        error: 'Toss API 주문 결과 미확정. 브로커에 주문이 남아 있을 수 있어 거래를 기록하지 않았습니다. 재승인하지 말고 reconcile 결과를 확인하세요.',
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
                        mode: bookedMode,
                        clientOrderId: bookingClientOrderId,
                    });
                    if (existingPos) {
                        // 0행 매칭이면 포지션이 그 사이 닫힌 것 — 매도 경로와 같이 롤백한다.
                        const merged = await averageIntoPosition(
                            tx,
                            existingPos.id,
                            actualQuantity,
                            filledPrice,
                        );
                        if (!merged) throw new Error('POSITION_ALREADY_CLOSED');
                    } else {
                        await openPosition(tx, {
                            symbol: order.symbol,
                            side: 'long',
                            quantity: actualQuantity,
                            avgPrice: filledPrice,
                        });
                    }
                    await markFilledInTracking(tx);
                });
            } else if (order.side === 'sell') {
                const pos = await getOpenPositionBySymbol(db, order.symbol);
                if (!pos) {
                    // No position to sell — record trade but warn
                    await db.transaction(async (tx) => {
                        await insertTrade(tx, {
                            symbol: order.symbol,
                            side: 'sell',
                            orderType: 'market',
                            quantity: actualQuantity,
                            price: filledPrice,
                            executedAt: new Date(),
                            reason: `${order.analysisSummary ?? '수동 승인'} (포지션 미확인 — 수동 확인 필요)`,
                            mode: bookedMode,
                            clientOrderId: bookingClientOrderId,
                        });
                        await markFilledInTracking(tx);
                    });
                    await dispatcher
                        .notifyError(
                            `포지션 미확인 매도: ${order.symbol}`,
                            `${order.symbol} 매도가 승인되었으나 DB에 해당 포지션이 없습니다. 수동 확인이 필요합니다.`,
                        )
                        .catch((e) => console.error('[email]', e));
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
                            mode: bookedMode,
                            clientOrderId: bookingClientOrderId,
                            realizedPnl: realizedPnlForSell(
                                filledPrice,
                                Number(pos.avgPrice),
                                actualQuantity,
                            ),
                        });
                        await markFilledInTracking(tx);
                    });
                } else {
                    // Partial close
                    await db.transaction(async (tx) => {
                        // 0 rows matched = the position was closed or shrunk between the
                        // lookup above and here (reconcile, execute cron, manual close).
                        // Booking the trade anyway would record a sell with realized PnL
                        // against a position that never moved — and that PnL feeds the daily
                        // loss circuit breaker. Same contract as the full-close branch.
                        const reduced = await reducePositionQuantity(tx, pos.id, actualQuantity);
                        if (!reduced) throw new Error('POSITION_ALREADY_CLOSED');
                        await insertTrade(tx, {
                            symbol: order.symbol,
                            side: order.side,
                            orderType: 'market',
                            quantity: actualQuantity,
                            price: filledPrice,
                            executedAt: new Date(),
                            reason: `${order.analysisSummary ?? '수동 승인'} (부분 매도)`,
                            mode: bookedMode,
                            clientOrderId: bookingClientOrderId,
                            realizedPnl: realizedPnlForSell(
                                filledPrice,
                                Number(pos.avgPrice),
                                actualQuantity,
                            ),
                        });
                        await markFilledInTracking(tx);
                    });
                }
            } else {
                await db.transaction(async (tx) => {
                    await insertTrade(tx, {
                        symbol: order.symbol,
                        side: order.side,
                        orderType: 'market',
                        quantity: actualQuantity,
                        price: filledPrice,
                        executedAt: new Date(),
                        reason: order.analysisSummary ?? '수동 승인',
                        mode: bookedMode,
                        clientOrderId: bookingClientOrderId,
                    });
                    await markFilledInTracking(tx);
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
            // Email alert about failure — A3: gated on master toggle + 'error' event.
            await dispatcher
                .notifyError(`승인 후 거래 기록 실패: ${order.symbol}`, String(err))
                .catch((emailErr) => console.error('[email] send failed:', emailErr));
            return Response.json(
                { error: 'Trade recording failed after approval' },
                { status: 500 },
            );
        }

        // A4: notify operator of every successfully booked fill, gated on 'trade_executed'.
        // Runs after all branches of the trade-recording try/catch so it always fires on success.
        await dispatcher
            .notifyTradeExecuted({
                symbol: order.symbol,
                side: order.side,
                quantity: actualQuantity,
                price: filledPrice,
                reason: order.analysisSummary ?? '수동 승인',
                mode: bookedMode,
            })
            .catch((e) => console.error('[email]', e));
    } else {
        const rejected = await rejectPendingOrder(db, id);
        if (!rejected) {
            return Response.json({ error: 'Order was already processed' }, { status: 409 });
        }
    }

    return Response.json({ success: true, action, id });
}

// Vercel Node runtime: expose Web `Request`/`Response` handlers via named HTTP-method
// exports. A bare `export default` would be treated as the legacy `(req, res)` handler.
export const POST = handler;
