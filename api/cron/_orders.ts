import crypto from 'node:crypto';
import { minutesUntilUsMarketClose } from '@y0ngha/siglens-core';
import type { Db } from '../../lib/db/index.js';
import {
    averageIntoPosition,
    closePosition,
    createOrderTracking,
    getOpenPositionBySymbol,
    insertPendingOrder,
    insertTrade,
    openPosition,
    reducePositionQuantity,
    updateOrderTracking,
} from '../../lib/db/queries.js';
import { executeBuyOrder, executeSellOrder } from '../../lib/trading/orders.js';
import { getSellableQuantity } from '../../lib/trading/account.js';
import { realizedPnlForSell } from '../../lib/strategy/pnl.js';
import { isFinitePositive, safeNumber } from '../../lib/validation.js';
import type { EmailDispatcher } from '../../lib/notification/dispatch.js';
import { etMinutesOfDay } from '../../lib/analysis/daily-bars.js';

/**
 * 세 모드(dry_run / semi_auto / auto)의 주문 실행 — execute 크론의 주문 코드를 **동작 그대로**
 * 옮긴 것이다(docs/specs/2026-09-24-daily-mean-reversion-design.md §4.2). 바뀐 것은 셋뿐이다:
 * 입력이 인자로 들어온다, dry_run 체결가에 비용이 붙는다(§4.4), 새 포지션에 재난 손절가가 실린다.
 *
 * 판단(무엇을, 얼마나)은 호출자 몫이고 여기서는 하지 않는다. 결과는 `OrderOutcome`으로 돌려주고
 * 호출자가 `cron_decisions`에 기록한다 — 주문이 나가지 않은 분기(거절·미체결·검토 필요·이미 닫힘)도
 * 전부 행동 이름과 `order` 감사 블록을 갖고 돌아온다. 그 행들이 "왜 안 됐나"를 되짚는 유일한 근거다.
 */

const APPROVAL_TTL_MS = 15 * 60 * 1000;
const APPROVE_URL = 'https://auto-trade.siglens.io/pending';

export type TradingMode = 'dry_run' | 'semi_auto' | 'auto';

export interface OrderContext {
    db: Db;
    tradingMode: TradingMode;
    cronRunId: string;
    dispatcher: EmailDispatcher;
    notifyError: (subject: string, body: string) => Promise<unknown>;
    /** dry_run 모의 체결 비용(편도, bp). */
    dryRunCostBps: number;
}

export interface OrderOutcome {
    /** 실제 체결이 장부에 기록됐는가. semi_auto 대기 주문은 체결이 아니므로 false. */
    executed: boolean;
    /** 정상 행동이 아닐 때의 결정 이름(`already_closed`, `order_rejected` …). 없으면 호출자가 정한다. */
    action?: string;
    /** 감사용 주문 블록 — 주문이 나가지 않은 분기에서도 의도 수량·브로커 상태를 남긴다. */
    order?: Record<string, unknown>;
    /** 원가 기준 노출 변화(매수 +, 매도 −). 호출자가 `currentExposure`에 더한다. */
    exposureDelta: number;
    /** 이번 주문이 쓴 현금(매수만). 호출자가 `remainingBuyingPower`에서 뺀다. */
    cashDebit: number;
}

/**
 * dry_run 체결가. 매수는 비싸게, 매도는 싸게 — 편도 `bps`만큼. 현금 원장(`getDryRunCashFlowUsd`)과
 * 실현 손익이 **같은 가격**에서 나와야 어긋나지 않으므로 trade·포지션·알림 모두 이 값을 쓴다.
 */
export function dryRunFillPrice(price: number, side: 'buy' | 'sell', bps: number): number {
    return side === 'buy' ? price * (1 + bps / 10_000) : price * (1 - bps / 10_000);
}

const noop = (exposureDelta = 0, cashDebit = 0) => ({ exposureDelta, cashDebit });

/**
 * semi_auto 대기 주문의 만료 시각 — `min(now + APPROVAL_TTL_MS, 장 마감)`(A5b).
 *
 * 종전에는 마감 5분 전에 낸 승인 대기가 15분 뒤(장 마감 후)까지 살아 있어, 운영자가 마감
 * 후에 승인을 누르면 지정가 매수/매도가 시간외로 나갈 수 있었다. 마감까지 남은 분이 0이면
 * (이미 마감했거나 장중이 아니면) 이 캡은 의미가 없으므로 기존 TTL을 그대로 쓴다.
 */
function approvalExpiresAt(now: Date): Date {
    const minutesToClose = minutesUntilUsMarketClose(now, etMinutesOfDay(now));
    const ttlExpiry = now.getTime() + APPROVAL_TTL_MS;
    if (minutesToClose > 0) {
        const closeAt = now.getTime() + minutesToClose * 60_000;
        return new Date(Math.min(ttlExpiry, closeAt));
    }
    return new Date(ttlExpiry);
}

function isAlreadyClosed(err: unknown): boolean {
    return err instanceof Error && err.message === 'POSITION_ALREADY_CLOSED';
}

/**
 * 보유 포지션 청산. 이동 원본: 종전 execute 재평가 루프의 `switch (tradingMode)`.
 * 부분 수량이면 포지션을 줄이고, 전량이면 닫는다.
 */
export async function executeExit(
    ctx: OrderContext,
    p: {
        position: { id: number; symbol: string; quantity: number; avgPrice: string | number };
        quantity: number;
        price: number;
        reason: string;
        /** 손절 계열이면 알림을 'stop_loss' 이벤트로 보낸다(운영자의 체크박스 선택을 존중). */
        isStopLoss: boolean;
    },
): Promise<OrderOutcome> {
    const { db, cronRunId, dispatcher, notifyError } = ctx;
    const { position, reason } = p;
    const exitQty = p.quantity;
    const avgPrice = safeNumber(Number(position.avgPrice), 0);
    const exitEvent = p.isStopLoss ? ('stop_loss' as const) : ('trade_executed' as const);

    switch (ctx.tradingMode) {
        case 'dry_run': {
            const fill = dryRunFillPrice(p.price, 'sell', ctx.dryRunCostBps);
            try {
                await db.transaction(async (tx) => {
                    // 부분 청산은 포지션을 남긴다 — 전량일 때만 닫는다.
                    if (exitQty >= position.quantity) {
                        const closed = await closePosition(tx, position.id, fill);
                        if (!closed) throw new Error('POSITION_ALREADY_CLOSED');
                    } else {
                        // 0행 매칭 = reconcile·수동 청산이 그 사이 포지션을 닫거나 줄였다. 그래도
                        // trade를 쓰면 움직이지 않은 포지션에 실현 손익이 붙어 손실 차단기 입력이 오염된다.
                        const reduced = await reducePositionQuantity(tx, position.id, exitQty);
                        if (!reduced) throw new Error('POSITION_ALREADY_CLOSED');
                    }
                    await insertTrade(tx, {
                        symbol: position.symbol,
                        side: 'sell',
                        orderType: 'market',
                        quantity: exitQty,
                        price: fill,
                        executedAt: new Date(),
                        reason,
                        mode: 'dry_run',
                        cronRunId,
                        realizedPnl: realizedPnlForSell(fill, Number(position.avgPrice), exitQty),
                    });
                });
            } catch (err) {
                if (isAlreadyClosed(err)) {
                    return {
                        executed: false,
                        action: 'already_closed',
                        order: { mode: 'dry_run' },
                        ...noop(),
                    };
                }
                throw err;
            }
            await dispatcher
                .notifyTradeExecuted(
                    {
                        symbol: position.symbol,
                        side: 'sell',
                        quantity: exitQty,
                        price: fill,
                        reason,
                        mode: 'dry_run',
                    },
                    exitEvent,
                )
                .catch((err) => console.error('[email] send failed:', err));
            // 노출은 원가 단위라 판 가격이 아니라 그 주식의 원가만큼 줄인다.
            return { executed: true, ...noop(-avgPrice * exitQty) };
        }

        case 'semi_auto': {
            await insertPendingOrder(db, {
                symbol: position.symbol,
                side: 'sell',
                quantity: exitQty,
                priceLimit: p.price,
                analysisSummary: reason,
                signalScore: 0,
                expiresAt: approvalExpiresAt(new Date()),
            });
            await dispatcher
                .notifyApprovalRequest({
                    symbol: position.symbol,
                    side: 'sell',
                    quantity: exitQty,
                    score: 0,
                    reason,
                    approveUrl: APPROVE_URL,
                })
                .catch((err) => console.error('[email] send failed:', err));
            // 승인 대기는 체결이 아니다.
            return { executed: false, ...noop() };
        }

        case 'auto': {
            // 매도 가능 수량 가드 — 브로커가 실제로 그만큼 들고 있는지. 클램프가 먼저, 거부가 나중이다:
            // 0<x<1 소수 잔량은 내림하면 0이 되고, 0주 주문을 내면 안 된다.
            let sellQty = exitQty;
            const sellable = await getSellableQuantity(position.symbol).catch(() => null);
            if (sellable != null) {
                const clamped = Math.min(sellQty, Math.floor(sellable));
                if (clamped <= 0) {
                    return {
                        executed: false,
                        action: 'skipped_not_sellable',
                        order: { intendedQty: exitQty, sellable },
                        ...noop(),
                    };
                }
                sellQty = clamped;
            }
            const idempotencyKey = `${cronRunId}-${position.symbol}-sell`;
            const clientOrderId = crypto.randomUUID();
            await createOrderTracking(db, {
                idempotencyKey,
                clientOrderId,
                symbol: position.symbol,
                side: 'sell',
                quantity: sellQty,
                status: 'submitted',
                cronRunId,
            });
            let orderResult;
            try {
                orderResult = await executeSellOrder(position.symbol, sellQty, clientOrderId);
            } catch (apiErr) {
                await updateOrderTracking(db, idempotencyKey, {
                    status: 'error',
                    resolvedAt: new Date(),
                }).catch(() => {});
                throw apiErr;
            }
            // 체결이 아닌 결과만 여기서 상태를 쓴다. 'filled'는 booking 트랜잭션 안(깨끗한 체결)이나
            // 아래 needs_review 쓰기에서만 — 그래서 trade 없는 'filled' 행이 존재할 수 없다.
            if (orderResult.status !== 'filled') {
                const resolved =
                    orderResult.status !== 'pending' && orderResult.status !== 'partial';
                await updateOrderTracking(db, idempotencyKey, {
                    tossOrderId: orderResult.orderId || undefined,
                    status: orderResult.status,
                    filledPrice: orderResult.avgFilledPrice ?? undefined,
                    resolvedAt: resolved ? new Date() : undefined,
                });
            }
            if (orderResult.status === 'rejected' || orderResult.status === 'canceled') {
                await notifyError(
                    `주문 거부: ${position.symbol}`,
                    orderResult.rejectReason ?? '거부 사유 없음',
                );
                return {
                    executed: false,
                    action: 'order_rejected',
                    order: {
                        intendedQty: exitQty,
                        submittedQty: sellQty,
                        status: orderResult.status,
                        rejectReason: orderResult.rejectReason ?? null,
                    },
                    ...noop(),
                };
            }
            // pending/partial: trade·포지션·노출 변경 없음. 최종 기록은 reconcile이 한다(단일 진실 원천).
            if (orderResult.status === 'pending' || orderResult.status === 'partial') {
                if (orderResult.status === 'partial') {
                    await notifyError(
                        `부분 체결: ${position.symbol}`,
                        `${position.symbol} sell ${orderResult.filledQuantity ?? '?'} / ${sellQty}주 부분 체결, 주문ID ${orderResult.orderId ?? 'N/A'}, reconcile가 잔량/최종 체결을 확정합니다.`,
                    );
                } else {
                    await notifyError(
                        `미체결 주문: ${position.symbol}`,
                        `${position.symbol} sell ${sellQty}주 주문이 접수되었으나 아직 체결되지 않았습니다. 주문 ID: ${orderResult.orderId ?? 'N/A'}`,
                    );
                }
                return {
                    executed: false,
                    action: orderResult.status === 'partial' ? 'order_partial' : 'order_submitted',
                    order: {
                        intendedQty: exitQty,
                        submittedQty: sellQty,
                        status: orderResult.status,
                        filledQuantity: orderResult.filledQuantity ?? null,
                        orderId: orderResult.orderId ?? null,
                    },
                    ...noop(),
                };
            }
            // 'filled' — 깨끗한 전량 체결만 자동 기록한다: 체결 수량 == 의도 정수 수량 AND 양수 체결가.
            // `!= null`만 보면 파싱 실패로 들어온 0이 통과해 매도 전량이 손실로 잡히고, 다음 틱에
            // 일일 손실 한도가 터진다.
            const filledQ = orderResult.filledQuantity ?? sellQty;
            const cleanFullFill =
                isFinitePositive(orderResult.avgFilledPrice) &&
                Number.isInteger(sellQty) &&
                Math.abs(filledQ - sellQty) < 1e-6;
            if (!cleanFullFill) {
                await updateOrderTracking(db, idempotencyKey, {
                    status: 'needs_review',
                    filledPrice: orderResult.avgFilledPrice ?? undefined,
                    resolvedAt: new Date(),
                });
                await notifyError(
                    `체결 수동확인 필요: ${position.symbol}`,
                    `sell 주문이 예상과 다르게 체결됨 (의도 ${sellQty}주, 체결 ${filledQ}, 체결가 ${orderResult.avgFilledPrice ?? '없음'}). 수동 기록 필요.`,
                ).catch((e) => console.error('[email]', e));
                return {
                    executed: false,
                    action: 'needs_review',
                    order: {
                        intendedQty: exitQty,
                        submittedQty: sellQty,
                        filledQuantity: filledQ,
                        filledPrice: orderResult.avgFilledPrice ?? null,
                    },
                    ...noop(),
                };
            }
            const filledPrice = orderResult.avgFilledPrice!;
            try {
                await db.transaction(async (tx) => {
                    if (sellQty >= position.quantity) {
                        const closed = await closePosition(tx, position.id, filledPrice);
                        if (!closed) throw new Error('POSITION_ALREADY_CLOSED');
                    } else {
                        const reduced = await reducePositionQuantity(tx, position.id, sellQty);
                        if (!reduced) throw new Error('POSITION_ALREADY_CLOSED');
                    }
                    await insertTrade(tx, {
                        symbol: position.symbol,
                        side: 'sell',
                        orderType: 'market',
                        quantity: sellQty,
                        price: filledPrice,
                        executedAt: new Date(),
                        reason,
                        mode: 'auto',
                        cronRunId,
                        clientOrderId,
                        realizedPnl: realizedPnlForSell(
                            filledPrice,
                            Number(position.avgPrice),
                            sellQty,
                        ),
                    });
                    // 원자적으로: 같은 트랜잭션에서 filled로 — trade 없는 filled가 생기지 않는다.
                    await updateOrderTracking(tx, idempotencyKey, {
                        tossOrderId: orderResult.orderId || undefined,
                        status: 'filled',
                        filledPrice,
                        resolvedAt: new Date(),
                    });
                });
            } catch (err) {
                if (isAlreadyClosed(err)) {
                    return {
                        executed: false,
                        action: 'already_closed',
                        order: { mode: 'auto', filledQuantity: sellQty, filledPrice },
                        ...noop(),
                    };
                }
                throw err;
            }
            await dispatcher
                .notifyTradeExecuted(
                    {
                        symbol: position.symbol,
                        side: 'sell',
                        quantity: sellQty,
                        price: filledPrice,
                        reason,
                        mode: 'auto',
                    },
                    exitEvent,
                )
                .catch((err) => console.error('[email] send failed:', err));
            return { executed: true, ...noop(-avgPrice * sellQty) };
        }
    }
}

/**
 * 신규 진입(매수). 이동 원본: 종전 execute 관심종목 루프의 매수 분기(dry_run / semi_auto / auto).
 * 물타기는 없다 — dry_run은 열린 포지션이 있으면 사지 않는다. auto는 **이미 체결된** 주문을 장부에
 * 올리는 단계라, 그 사이 포지션이 생겼다면 버리지 않고 평단에 합친다(체결은 사실이다).
 */
export async function executeEntry(
    ctx: OrderContext,
    p: {
        symbol: string;
        quantity: number;
        price: number;
        reason: string;
        /** 새 포지션의 재난 손절가(null = 손절 없음). */
        stopPrice: number | null;
        /** 승인 대기열·알림에 보이는 점수 칸. 이 전략에서는 RSI(2). */
        score: number;
        /** auto의 매수 여력 잔고(런 안에서 차감되는 값). null = 조회 실패 → fail-closed. */
        remainingBuyingPower: number | null;
    },
): Promise<OrderOutcome> {
    const { db, cronRunId, dispatcher, notifyError } = ctx;
    const { symbol, quantity, reason } = p;

    switch (ctx.tradingMode) {
        case 'dry_run': {
            const fill = dryRunFillPrice(p.price, 'buy', ctx.dryRunCostBps);
            if (await getOpenPositionBySymbol(db, symbol)) {
                return { executed: false, action: 'already_open', ...noop() };
            }
            await db.transaction(async (tx) => {
                await insertTrade(tx, {
                    symbol,
                    side: 'buy',
                    orderType: 'market',
                    quantity,
                    price: fill,
                    executedAt: new Date(),
                    reason,
                    mode: 'dry_run',
                    cronRunId,
                });
                await openPosition(tx, {
                    symbol,
                    side: 'long',
                    quantity,
                    avgPrice: fill,
                    stopPrice: p.stopPrice,
                });
            });
            await dispatcher
                .notifyTradeExecuted({
                    symbol,
                    side: 'buy',
                    quantity,
                    price: fill,
                    reason,
                    mode: 'dry_run',
                })
                .catch((err) => console.error('[email] send failed:', err));
            // 모의 잔고도 런 안에서 차감한다 — 그러지 않으면 한 런의 매수 여러 건이 같은 잔고를 본다.
            return { executed: true, ...noop(fill * quantity, fill * quantity) };
        }

        case 'semi_auto': {
            await insertPendingOrder(db, {
                symbol,
                side: 'buy',
                quantity,
                priceLimit: p.price,
                analysisSummary: reason,
                signalScore: p.score,
                expiresAt: approvalExpiresAt(new Date()),
            });
            await dispatcher
                .notifyApprovalRequest({
                    symbol,
                    side: 'buy',
                    quantity,
                    score: p.score,
                    reason,
                    approveUrl: APPROVE_URL,
                })
                .catch((err) => console.error('[email] send failed:', err));
            // 대기 매수도 노출로 센다 — 안 세면 매 틱 새 종목에 승인 요청이 쌓여 한도를 넘는다.
            // 현금도 같이 차감해야 한다(A9) — semi_auto도 승인 시점에 실주문이 나가 실계좌
            // 현금으로 사이징하므로, 같은 런의 다음 진입이 이 대기 매수를 뺀 잔여 현금을 본다.
            return { executed: false, ...noop(p.price * quantity, p.price * quantity) };
        }

        case 'auto': {
            // 매수 여력을 모르면 fail-closed — 현금이 있는지 확인할 수 없다.
            if (p.remainingBuyingPower === null) {
                return {
                    executed: false,
                    action: 'skipped_no_buying_power',
                    order: { intendedQty: quantity, availableCash: null },
                    ...noop(),
                };
            }
            if (p.price * quantity > p.remainingBuyingPower) {
                return {
                    executed: false,
                    action: 'skipped_insufficient_cash',
                    order: {
                        intendedQty: quantity,
                        cost: p.price * quantity,
                        availableCash: p.remainingBuyingPower,
                    },
                    ...noop(),
                };
            }
            // 재확인(A7) — 호출자의 in-flight 가드와 이 제출 사이에 reconcile 지연 체결 복구가
            // 끼어들면 포지션이 이미 있을 수 있다. dry_run과 같은 응답으로 물타기를 막는다.
            if (await getOpenPositionBySymbol(db, symbol)) {
                return { executed: false, action: 'already_open', ...noop() };
            }
            const idempotencyKey = `${cronRunId}-${symbol}-buy`;
            const clientOrderId = crypto.randomUUID();
            await createOrderTracking(db, {
                idempotencyKey,
                clientOrderId,
                symbol,
                side: 'buy',
                quantity,
                status: 'submitted',
                cronRunId,
            });
            let orderResult;
            try {
                orderResult = await executeBuyOrder(symbol, quantity, clientOrderId);
            } catch (apiErr) {
                await updateOrderTracking(db, idempotencyKey, {
                    status: 'error',
                    resolvedAt: new Date(),
                }).catch(() => {});
                throw apiErr;
            }
            if (orderResult.status !== 'filled') {
                const resolved =
                    orderResult.status !== 'pending' && orderResult.status !== 'partial';
                await updateOrderTracking(db, idempotencyKey, {
                    tossOrderId: orderResult.orderId || undefined,
                    status: orderResult.status,
                    filledPrice: orderResult.avgFilledPrice ?? undefined,
                    resolvedAt: resolved ? new Date() : undefined,
                });
            }
            if (orderResult.status === 'rejected' || orderResult.status === 'canceled') {
                await notifyError(
                    `주문 거부: ${symbol}`,
                    orderResult.rejectReason ?? '거부 사유 없음',
                );
                return {
                    executed: false,
                    action: 'order_rejected',
                    order: {
                        intendedQty: quantity,
                        submittedQty: quantity,
                        status: orderResult.status,
                        rejectReason: orderResult.rejectReason ?? null,
                    },
                    ...noop(),
                };
            }
            // 살아 있는 주문(filled/partial/pending)은 현금을 쓴다 — 이 런의 다음 매수가 줄어든 현금을
            // 보도록 낙관적으로 차감한다. 깨끗한 체결은 체결가, 미확정은 요청가로.
            const debitPrice =
                orderResult.status === 'filled' && orderResult.avgFilledPrice != null
                    ? orderResult.avgFilledPrice
                    : p.price;
            const cashDebit = debitPrice * quantity;
            if (orderResult.status === 'pending' || orderResult.status === 'partial') {
                if (orderResult.status === 'partial') {
                    await notifyError(
                        `부분 체결: ${symbol}`,
                        `${symbol} ${orderResult.filledQuantity ?? '?'} / ${quantity}주 부분 체결, 주문ID ${orderResult.orderId ?? 'N/A'}, reconcile가 잔량/최종 체결을 확정합니다.`,
                    );
                } else {
                    await notifyError(
                        `미체결 주문: ${symbol}`,
                        `${symbol} buy ${quantity}주 주문이 접수되었으나 아직 체결되지 않았습니다. 주문 ID: ${orderResult.orderId ?? 'N/A'}`,
                    );
                }
                return {
                    executed: false,
                    action: orderResult.status === 'partial' ? 'order_partial' : 'order_submitted',
                    order: {
                        intendedQty: quantity,
                        submittedQty: quantity,
                        status: orderResult.status,
                        filledQuantity: orderResult.filledQuantity ?? null,
                        orderId: orderResult.orderId ?? null,
                    },
                    // 살아 있는 주문은 노출도 쓴다(A9) — 계획된 명목가 기준. 0으로 두면 같은 런의
                    // 다음 진입이 이 주문을 못 본 채 총 노출 한도를 넘겨 승인/제출한다.
                    ...noop(p.price * quantity, cashDebit),
                };
            }
            const filledQ = orderResult.filledQuantity ?? quantity;
            const cleanFullFill =
                isFinitePositive(orderResult.avgFilledPrice) &&
                Number.isInteger(quantity) &&
                Math.abs(filledQ - quantity) < 1e-6;
            if (!cleanFullFill) {
                await updateOrderTracking(db, idempotencyKey, {
                    status: 'needs_review',
                    filledPrice: orderResult.avgFilledPrice ?? undefined,
                    resolvedAt: new Date(),
                });
                await notifyError(
                    `체결 수동확인 필요: ${symbol}`,
                    `buy 주문이 예상과 다르게 체결됨 (의도 ${quantity}주, 체결 ${filledQ}, 체결가 ${orderResult.avgFilledPrice ?? '없음'}). 수동 기록 필요.`,
                ).catch((e) => console.error('[email]', e));
                return {
                    executed: false,
                    action: 'needs_review',
                    order: {
                        intendedQty: quantity,
                        submittedQty: quantity,
                        filledQuantity: filledQ,
                        filledPrice: orderResult.avgFilledPrice ?? null,
                    },
                    ...noop(0, cashDebit),
                };
            }
            const filledPrice = orderResult.avgFilledPrice!;
            const existing = await getOpenPositionBySymbol(db, symbol);
            await db.transaction(async (tx) => {
                await insertTrade(tx, {
                    symbol,
                    side: 'buy',
                    orderType: 'market',
                    quantity,
                    price: filledPrice,
                    executedAt: new Date(),
                    reason,
                    mode: 'auto',
                    cronRunId,
                    clientOrderId,
                });
                if (existing) {
                    // 조회 후 포지션이 닫혔으면 롤백한다 — trade만 남고 포지션이 없으면 그 주식의
                    // 손절선이 영원히 작동하지 않는다.
                    const merged = await averageIntoPosition(
                        tx,
                        existing.id,
                        quantity,
                        filledPrice,
                    );
                    if (!merged) throw new Error('POSITION_ALREADY_CLOSED');
                } else {
                    await openPosition(tx, {
                        symbol,
                        side: 'long',
                        quantity,
                        avgPrice: filledPrice,
                        stopPrice: p.stopPrice,
                    });
                }
                await updateOrderTracking(tx, idempotencyKey, {
                    tossOrderId: orderResult.orderId || undefined,
                    status: 'filled',
                    filledPrice,
                    resolvedAt: new Date(),
                });
            });
            await dispatcher
                .notifyTradeExecuted({
                    symbol,
                    side: 'buy',
                    quantity,
                    price: filledPrice,
                    reason,
                    mode: 'auto',
                })
                .catch((err) => console.error('[email] send failed:', err));
            return { executed: true, ...noop(filledPrice * quantity, cashDebit) };
        }
    }
}
