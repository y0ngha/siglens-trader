import { sql, type SQL } from 'drizzle-orm';
import type { Db } from './index.js';
import { orderTracking, trades } from './schema.js';
import {
    insertTrade,
    openPosition,
    closePosition,
    reducePositionQuantity,
    averageIntoPosition,
    getOpenPositionBySymbol,
    updateOrderTracking,
} from './queries.js';

export interface RecoveryReport {
    filledOrdersWithoutTrades: number;
    filledOrdersWithoutPositions: number;
    openPositionsWithoutTrades: number;
    alerts: string[];
}

export interface AutoRecoveryResult {
    recovered: number;
    failed: number;
    details: string[];
}

/**
 * Builds the WHERE clause that decides whether a booked trade already exists
 * for a filled order.
 *
 * - When the order carries a `clientOrderId` (every facade-placed order does),
 *   match precisely on `trades.client_order_id` — this detects whether execute
 *   already booked this exact order, with no symbol/side/time ambiguity.
 * - Legacy/null orders fall back to the loose symbol + side + executed-after
 *   condition (best effort for rows booked before client_order_id existed).
 */
function matchingTradeWhere(order: {
    symbol: string;
    side: string;
    submittedAt: Date | null;
    clientOrderId: string | null;
}): SQL {
    if (order.clientOrderId) {
        return sql`${trades.clientOrderId} = ${order.clientOrderId}`;
    }
    return sql`${trades.symbol} = ${order.symbol} AND ${trades.side} = ${order.side} AND ${trades.executedAt} > ${order.submittedAt}`;
}

/**
 * Checks for DB state inconsistencies between order_tracking and trades.
 *
 * Specifically, finds orders marked 'filled' in the last 24 hours that
 * have no corresponding trade record (matching symbol + side + executed
 * after the order was submitted). This detects cases where the broker
 * confirmed a fill but the trade/position bookkeeping failed.
 */
export async function checkConsistency(db: Db): Promise<RecoveryReport> {
    const alerts: string[] = [];

    const filledOrders = await db
        .select()
        .from(orderTracking)
        .where(
            sql`${orderTracking.status} = 'filled' AND ${orderTracking.resolvedAt} > now() - interval '24 hours'`,
        );

    let filledOrdersWithoutTrades = 0;
    for (const order of filledOrders) {
        const matchingTrades = await db.select().from(trades).where(matchingTradeWhere(order));

        if (matchingTrades.length === 0) {
            filledOrdersWithoutTrades++;
            alerts.push(
                `Filled order ${order.idempotencyKey} (${order.symbol} ${order.side}) has no matching trade`,
            );
        }
    }

    return {
        filledOrdersWithoutTrades,
        filledOrdersWithoutPositions: 0, // TODO: similar check for positions
        openPositionsWithoutTrades: 0, // TODO
        alerts,
    };
}

/**
 * Takes an unrecoverable order out of the retry set.
 *
 * `autoRecoverFilledOrders` only looks at status 'filled', so anything left there is
 * retried every reconcile tick for 24 hours — and reconcile mails on every failure.
 * Best-effort: if this write fails the retry loop is the fallback, not a crash.
 */
async function markNeedsReview(db: Db, idempotencyKey: string) {
    await updateOrderTracking(db, idempotencyKey, {
        status: 'needs_review',
        resolvedAt: new Date(),
    }).catch((e) => console.error('[recovery] needs_review write failed', idempotencyKey, e));
}

/**
 * Auto-recovers filled orders from the last 24 hours that have no matching
 * trade record. For each orphaned order, creates the missing trade and
 * updates the position (open/average-in for buys, close/reduce for sells).
 *
 * Orders without a valid filledPrice are skipped and flagged for manual review.
 * Successfully recovered orders are marked with status 'recovered' in order_tracking.
 */
/**
 * 포지션 경합으로 실패한 복구를 재시도하는 유예 구간 (1시간).
 *
 * reconcile은 10분마다 도므로 최대 6회 재시도한 뒤 사람에게 넘어간다.
 */
const RECOVERY_RETRY_WINDOW_MS = 60 * 60_000;

export async function autoRecoverFilledOrders(db: Db): Promise<AutoRecoveryResult> {
    const details: string[] = [];
    let recovered = 0;
    let failed = 0;

    // Find filled orders from last 24h
    const filledOrders = await db
        .select()
        .from(orderTracking)
        .where(
            sql`${orderTracking.status} = 'filled' AND ${orderTracking.resolvedAt} > now() - interval '24 hours'`,
        );

    for (const order of filledOrders) {
        // Check if a matching trade already exists
        const matchingTrades = await db
            .select()
            .from(trades)
            .where(matchingTradeWhere(order))
            .limit(1);

        if (matchingTrades.length > 0) continue; // Trade exists, no recovery needed

        // Auto-recover: create the missing trade + position
        try {
            const price = Number(order.filledPrice);
            if (!Number.isFinite(price) || price <= 0) {
                details.push(
                    `${order.symbol} ${order.side}: 체결가 없어 자동 복구 불가 (수동 확인 필요)`,
                );
                failed++;
                await markNeedsReview(db, order.idempotencyKey);
                continue;
            }

            const { quantity } = order;

            // Look up existing position outside transaction.
            // Safe because reconcile cron holds a distributed lock,
            // preventing concurrent modifications.
            const existingPosition = await getOpenPositionBySymbol(db, order.symbol);

            // realized PnL for sells that close/reduce a known long position.
            // lib/db는 lib/strategy 임포트 금지 → realizedPnlForSell 공식 인라인 (센트 반올림).
            // Buys / no-position sells → undefined.
            const avgPrice = existingPosition ? Number(existingPosition.avgPrice) : NaN;
            const recoveredRealizedPnl =
                order.side === 'sell' && existingPosition && Number.isFinite(avgPrice)
                    ? Math.round((price - avgPrice) * quantity * 100) / 100
                    : undefined;

            await db.transaction(async (tx) => {
                // Insert the missing trade
                await insertTrade(tx, {
                    symbol: order.symbol,
                    side: order.side,
                    orderType: 'market',
                    quantity,
                    price,
                    executedAt: order.resolvedAt ?? new Date(),
                    reason: `자동 복구 — orderTracking ${order.idempotencyKey}에서 복원`,
                    mode: 'auto',
                    cronRunId: order.cronRunId ?? undefined,
                    clientOrderId: order.clientOrderId ?? undefined,
                    realizedPnl: recoveredRealizedPnl,
                });

                // Update position
                if (order.side === 'buy') {
                    if (existingPosition) {
                        // 매도 쪽과 같은 이유로 rowCount를 본다 — 조회는 트랜잭션 밖이라
                        // 그 사이 포지션이 닫혔으면 trade만 남고 포지션이 없는 상태가 된다.
                        const merged = await averageIntoPosition(
                            tx,
                            existingPosition.id,
                            quantity,
                            price,
                        );
                        if (!merged) throw new Error('POSITION_ALREADY_CLOSED');
                    } else {
                        await openPosition(tx, {
                            symbol: order.symbol,
                            side: 'long',
                            quantity,
                            avgPrice: price,
                        });
                    }
                } else if (order.side === 'sell') {
                    if (existingPosition) {
                        // The position was looked up outside the transaction. If it was
                        // closed or shrunk in between (execute cron, manual close), the
                        // update matches 0 rows — abort so the whole recovery rolls back and
                        // is retried, instead of booking a sell with realized PnL against a
                        // position that never moved.
                        const applied =
                            quantity >= existingPosition.quantity
                                ? await closePosition(tx, existingPosition.id, price)
                                : await reducePositionQuantity(tx, existingPosition.id, quantity);
                        if (!applied) throw new Error('POSITION_ALREADY_CLOSED');
                    } else {
                        details.push(
                            `${order.symbol} sell: 거래 기록은 생성했으나 DB에 열린 포지션 없음 (브로커 확인 필요)`,
                        );
                    }
                }
            });

            // Mark as recovered in orderTracking (outside transaction — the trade is already committed)
            await updateOrderTracking(db, order.idempotencyKey, {
                status: 'recovered',
                resolvedAt: new Date(),
            });

            recovered++;
            details.push(`${order.symbol} ${order.side} ${quantity}주 @ $${price}: 자동 복구 완료`);
        } catch (err) {
            failed++;
            details.push(`${order.symbol} ${order.side}: 자동 복구 실패 — ${String(err)}`);
            // `POSITION_ALREADY_CLOSED`는 **일시적 경합**이다 — 조회와 UPDATE 사이에 execute나
            // 수동 청산이 포지션을 건드렸다는 뜻이고, 주석이 말하는 대로 "롤백하고 재시도"가
            // 의도다. 그런데 무조건 `needs_review`로 넘기면 이 주문이 `filled` 조회 집합에서
            // 빠져 **재시도가 영영 일어나지 않고**, 체결된 매도가 장부에서 사라진다
            // (= 실현 손익이 일일 손실 차단기 입력에서 누락).
            //
            // 그렇다고 계속 `filled`로 두면 24시간 동안 10분마다 재시도하며 매번 메일이 나간다.
            // 그래서 시간으로 가른다: 경합은 보통 다음 실행에서 풀리므로 짧은 유예 동안만
            // 재시도하고, 그 뒤에도 실패하면 사람에게 넘긴다.
            const isRace = err instanceof Error && err.message === 'POSITION_ALREADY_CLOSED';
            const age = Date.now() - new Date(order.submittedAt).getTime();
            if (isRace && age < RECOVERY_RETRY_WINDOW_MS) {
                details.push(
                    `${order.symbol} ${order.side}: 포지션 경합 — 다음 실행에서 재시도합니다`,
                );
                continue;
            }
            await markNeedsReview(db, order.idempotencyKey);
        }
    }

    return { recovered, failed, details };
}
