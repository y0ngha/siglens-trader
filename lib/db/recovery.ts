import { sql } from 'drizzle-orm';
import type { Db } from './index';
import { orderTracking, trades } from './schema';
import {
    insertTrade,
    openPosition,
    closePosition,
    reducePositionQuantity,
    averageIntoPosition,
    getOpenPositionBySymbol,
    updateOrderTracking,
} from './queries';

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
        const matchingTrades = await db
            .select()
            .from(trades)
            .where(
                sql`${trades.symbol} = ${order.symbol} AND ${trades.side} = ${order.side} AND ${trades.executedAt} > ${order.submittedAt}`,
            );

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
 * Auto-recovers filled orders from the last 24 hours that have no matching
 * trade record. For each orphaned order, creates the missing trade and
 * updates the position (open/average-in for buys, close/reduce for sells).
 *
 * Orders without a valid filledPrice are skipped and flagged for manual review.
 * Successfully recovered orders are marked with status 'recovered' in order_tracking.
 */
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
            .where(
                sql`${trades.symbol} = ${order.symbol} AND ${trades.side} = ${order.side} AND ${trades.executedAt} > ${order.submittedAt}`,
            )
            .limit(1);

        if (matchingTrades.length > 0) continue; // Trade exists, no recovery needed

        // Auto-recover: create the missing trade + position
        try {
            const price = order.filledPrice ? Number(order.filledPrice) : 0;
            if (price <= 0) {
                details.push(
                    `${order.symbol} ${order.side}: 체결가 없어 자동 복구 불가 (수동 확인 필요)`,
                );
                failed++;
                continue;
            }

            const { quantity } = order;

            // Look up existing position outside transaction.
            // Safe because reconcile cron holds a distributed lock,
            // preventing concurrent modifications.
            const existingPosition = await getOpenPositionBySymbol(db, order.symbol);

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
                });

                // Update position
                if (order.side === 'buy') {
                    if (existingPosition) {
                        await averageIntoPosition(tx, existingPosition.id, quantity, price);
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
                        if (quantity >= existingPosition.quantity) {
                            await closePosition(tx, existingPosition.id, price);
                        } else {
                            await reducePositionQuantity(tx, existingPosition.id, quantity);
                        }
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
        }
    }

    return { recovered, failed, details };
}
