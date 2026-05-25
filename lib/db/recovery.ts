import { sql } from 'drizzle-orm';
import type { Db } from './index';
import { orderTracking, trades } from './schema';

export interface RecoveryReport {
    filledOrdersWithoutTrades: number;
    filledOrdersWithoutPositions: number;
    openPositionsWithoutTrades: number;
    alerts: string[];
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
