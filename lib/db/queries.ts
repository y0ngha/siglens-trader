import { eq, desc, and, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from './index';
import {
    watchlist,
    analysisModelConfig,
    analysisResults,
    positions,
    trades,
    pendingOrders,
    config,
    notificationConfig,
    orderTracking,
} from './schema';

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

export async function getEnabledWatchlist(db: Db) {
    return db.select().from(watchlist).where(eq(watchlist.enabled, true));
}

export async function getAllWatchlist(db: Db) {
    return db.select().from(watchlist);
}

export async function addToWatchlist(db: Db, symbol: string, companyName: string) {
    return db.insert(watchlist).values({ symbol, companyName }).returning();
}

export async function removeFromWatchlist(db: Db, id: number) {
    return db.delete(watchlist).where(eq(watchlist.id, id));
}

export async function toggleWatchlistItem(db: Db, id: number, enabled: boolean) {
    return db.update(watchlist).set({ enabled }).where(eq(watchlist.id, id));
}

// ---------------------------------------------------------------------------
// Analysis config
// ---------------------------------------------------------------------------

export async function getAnalysisConfig(db: Db, type: string) {
    const rows = await db
        .select()
        .from(analysisModelConfig)
        .where(eq(analysisModelConfig.analysisType, type))
        .limit(1);
    return rows[0] ?? null;
}

export async function getAllAnalysisConfigs(db: Db) {
    return db.select().from(analysisModelConfig);
}

export async function updateAnalysisConfig(
    db: Db,
    type: string,
    updates: { modelId?: string; enabled?: boolean; useByok?: boolean },
) {
    return db
        .update(analysisModelConfig)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(analysisModelConfig.analysisType, type));
}

// ---------------------------------------------------------------------------
// Config (key-value)
// ---------------------------------------------------------------------------

export async function getConfigValue<T>(db: Db, key: string): Promise<T | null> {
    const rows = await db.select().from(config).where(eq(config.key, key)).limit(1);
    if (!rows[0]) return null;
    return rows[0].value as T;
}

export async function setConfigValue(db: Db, key: string, value: unknown) {
    return db
        .insert(config)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
            target: config.key,
            set: { value, updatedAt: new Date() },
        });
}

export async function getAllConfig(db: Db) {
    return db.select().from(config);
}

// ---------------------------------------------------------------------------
// Analysis results
// ---------------------------------------------------------------------------

export async function saveAnalysisResult(
    db: Db,
    params: {
        symbol: string;
        analysisType: string;
        result: unknown;
        modelId: string;
        analyzedAt: Date;
        cronRunId?: string;
    },
) {
    return db.insert(analysisResults).values(params).returning();
}

export async function getLatestAnalysisResult(db: Db, symbol: string, type: string) {
    const rows = await db
        .select()
        .from(analysisResults)
        .where(and(eq(analysisResults.symbol, symbol), eq(analysisResults.analysisType, type)))
        .orderBy(desc(analysisResults.analyzedAt))
        .limit(1);
    return rows[0] ?? null;
}

export async function getLatestAnalysisResults(db: Db, symbol: string, limit = 50) {
    return db
        .select()
        .from(analysisResults)
        .where(eq(analysisResults.symbol, symbol))
        .orderBy(desc(analysisResults.analyzedAt))
        .limit(limit);
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export async function getOpenPositions(db: Db) {
    return db.select().from(positions).where(eq(positions.status, 'open'));
}

export async function getOpenPositionBySymbol(db: Db, symbol: string) {
    const rows = await db
        .select()
        .from(positions)
        .where(and(eq(positions.symbol, symbol), eq(positions.status, 'open')))
        .limit(1);
    return rows[0] ?? null;
}

export async function openPosition(
    db: DbOrTx,
    params: { symbol: string; side: string; quantity: number; avgPrice: number },
) {
    return db
        .insert(positions)
        .values({
            symbol: params.symbol,
            side: params.side,
            quantity: params.quantity,
            avgPrice: String(params.avgPrice),
            openedAt: new Date(),
            status: 'open',
        })
        .returning();
}

export async function closePosition(db: DbOrTx, id: number, closePrice: number) {
    const result = await db
        .update(positions)
        .set({
            status: 'closed',
            closedAt: new Date(),
            closePrice: String(closePrice),
        })
        .where(and(eq(positions.id, id), eq(positions.status, 'open')))
        .returning({ id: positions.id });
    return result.length > 0;
}

/**
 * Reduce an open position's quantity after a partial sell.
 * Only updates if the position is open and has more shares than `soldQuantity`.
 * Returns true if the update matched a row, false otherwise.
 */
export async function reducePositionQuantity(
    db: DbOrTx,
    id: number,
    soldQuantity: number,
): Promise<boolean> {
    const result = await db.execute(sql`
        UPDATE positions
        SET quantity = quantity - ${soldQuantity}
        WHERE id = ${id} AND status = 'open' AND quantity >= ${soldQuantity}
        RETURNING id
    `);
    return (result as any).length > 0 || (result as any).rowCount > 0;
}

/**
 * Average into an existing open position by adding quantity at a new price.
 * Uses a single atomic SQL UPDATE with full NUMERIC precision to avoid
 * read-then-write race conditions.
 */
export async function averageIntoPosition(
    db: DbOrTx,
    positionId: number,
    additionalQuantity: number,
    additionalPrice: number,
) {
    return db.execute(sql`
        UPDATE positions
        SET quantity = quantity + ${additionalQuantity},
            avg_price = ((quantity * avg_price::numeric + ${additionalQuantity} * ${additionalPrice}) / (quantity + ${additionalQuantity}))::text
        WHERE id = ${positionId} AND status = 'open'
    `);
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export async function insertTrade(
    db: DbOrTx,
    params: {
        symbol: string;
        side: string;
        orderType: string;
        quantity: number;
        price: number;
        executedAt: Date;
        reason?: string;
        mode: string;
        cronRunId?: string;
    },
) {
    return db
        .insert(trades)
        .values({
            symbol: params.symbol,
            side: params.side,
            orderType: params.orderType,
            quantity: params.quantity,
            price: String(params.price),
            executedAt: params.executedAt,
            reason: params.reason,
            mode: params.mode,
            cronRunId: params.cronRunId,
        })
        .returning();
}

export async function getRecentTrades(db: Db, limit = 50) {
    return db.select().from(trades).orderBy(desc(trades.executedAt)).limit(limit);
}

export async function dismissTrade(db: Db, id: number) {
    return db.update(trades).set({ dismissedAt: new Date() }).where(eq(trades.id, id));
}

export async function getTodayTradeCount(db: Db) {
    const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(trades)
        .where(
            sql`${trades.executedAt} AT TIME ZONE 'America/New_York' >= date_trunc('day', now() AT TIME ZONE 'America/New_York')
                AND ${trades.mode} != 'skipped'`,
        );
    return Number(rows[0]?.count ?? 0);
}

/**
 * Returns today's realized PnL from two sources:
 *
 * 1. Fully closed positions: `(closePrice - avgPrice) * quantity` for long positions
 *    (or inverted for short). This captures the actual realized profit when a
 *    position is closed entirely.
 *
 * 2. Partial sells against still-open positions: `(sellPrice - avgPrice) * quantity`.
 *    This captures profit from today's sell trades where the position remains open
 *    (reduced quantity). Joined against the position's current avgPrice.
 *
 * The previous net-cash-flow approach (sell=+revenue, buy=-cost) triggered
 * false alarms on buy-heavy days because buys lowered the PnL even though
 * they represent unrealized positions, not losses.
 *
 * Skipped and dry_run trades are excluded from the partial-sell calculation.
 */
export async function getTodayRealizedPnl(db: Db): Promise<number> {
    // PnL from positions fully closed today
    const closedRows = await db
        .select({
            pnl: sql<number>`COALESCE(SUM(
                CASE
                    WHEN ${positions.side} = 'short' THEN (${positions.avgPrice}::numeric - ${positions.closePrice}::numeric) * ${positions.quantity}
                    ELSE (${positions.closePrice}::numeric - ${positions.avgPrice}::numeric) * ${positions.quantity}
                END
            ), 0)`,
        })
        .from(positions)
        .where(
            and(
                eq(positions.status, 'closed'),
                sql`${positions.closedAt} AT TIME ZONE 'America/New_York' >= date_trunc('day', now() AT TIME ZONE 'America/New_York')`,
            ),
        );

    // PnL from partial sells (position still open, reduced quantity)
    const partialRows = await db.execute(sql`
        SELECT COALESCE(SUM(
            (t.price::numeric - p.avg_price::numeric) * t.quantity
        ), 0) as pnl
        FROM trades t
        INNER JOIN positions p ON t.symbol = p.symbol AND p.status = 'open'
        WHERE t.side = 'sell'
        AND t.mode NOT IN ('skipped', 'dry_run')
        AND t.executed_at AT TIME ZONE 'America/New_York' >= date_trunc('day', now() AT TIME ZONE 'America/New_York')
    `);

    const closedPnl = Number(closedRows[0]?.pnl ?? 0);
    const partialPnl = Number((partialRows as any)[0]?.pnl ?? 0);

    return closedPnl + partialPnl;
}

// ---------------------------------------------------------------------------
// Pending orders
// ---------------------------------------------------------------------------

export async function insertPendingOrder(
    db: Db,
    params: {
        symbol: string;
        side: string;
        quantity: number;
        priceLimit?: number;
        analysisSummary?: string;
        signalScore?: number;
        expiresAt: Date;
    },
) {
    return db
        .insert(pendingOrders)
        .values({
            symbol: params.symbol,
            side: params.side,
            quantity: params.quantity,
            priceLimit: params.priceLimit != null ? String(params.priceLimit) : undefined,
            analysisSummary: params.analysisSummary,
            signalScore: params.signalScore != null ? String(params.signalScore) : undefined,
            expiresAt: params.expiresAt,
            status: 'pending',
        })
        .returning();
}

export async function getPendingOrders(db: Db) {
    return db
        .select()
        .from(pendingOrders)
        .where(and(eq(pendingOrders.status, 'pending'), sql`${pendingOrders.expiresAt} > now()`))
        .orderBy(desc(pendingOrders.createdAt));
}

export async function getPendingOrderById(db: Db, id: number) {
    const rows = await db.select().from(pendingOrders).where(eq(pendingOrders.id, id)).limit(1);
    return rows[0] ?? null;
}

export async function approvePendingOrder(db: Db, id: number) {
    const result = await db
        .update(pendingOrders)
        .set({ status: 'approved' })
        .where(and(eq(pendingOrders.id, id), eq(pendingOrders.status, 'pending')))
        .returning({ id: pendingOrders.id });
    return result.length > 0;
}

export async function revertPendingOrder(db: Db, id: number) {
    const result = await db
        .update(pendingOrders)
        .set({ status: 'pending' })
        .where(and(eq(pendingOrders.id, id), eq(pendingOrders.status, 'approved')))
        .returning({ id: pendingOrders.id });
    return result.length > 0;
}

export async function rejectPendingOrder(db: Db, id: number) {
    const result = await db
        .update(pendingOrders)
        .set({ status: 'rejected' })
        .where(and(eq(pendingOrders.id, id), eq(pendingOrders.status, 'pending')))
        .returning({ id: pendingOrders.id });
    return result.length > 0;
}

export async function expireOldPendingOrders(db: Db) {
    return db
        .update(pendingOrders)
        .set({ status: 'expired' })
        .where(and(eq(pendingOrders.status, 'pending'), sql`${pendingOrders.expiresAt} <= now()`));
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function getNotificationConfig(db: Db) {
    return db.select().from(notificationConfig);
}

export async function updateNotificationConfig(
    db: Db,
    channel: string,
    updates: { enabled?: boolean; target?: string; events?: string[] },
) {
    return db
        .update(notificationConfig)
        .set(updates)
        .where(eq(notificationConfig.channel, channel));
}

// ---------------------------------------------------------------------------
// Order tracking
// ---------------------------------------------------------------------------

export async function createOrderTracking(
    db: Db,
    params: {
        idempotencyKey: string;
        symbol: string;
        side: string;
        quantity: number;
        tossOrderId?: string;
        clientOrderId?: string;
        status: string;
        cronRunId?: string;
    },
) {
    return db
        .insert(orderTracking)
        .values({
            idempotencyKey: params.idempotencyKey,
            symbol: params.symbol,
            side: params.side,
            quantity: params.quantity,
            tossOrderId: params.tossOrderId,
            clientOrderId: params.clientOrderId,
            status: params.status,
            cronRunId: params.cronRunId,
        })
        .returning();
}

export async function updateOrderTracking(
    db: Db,
    idempotencyKey: string,
    updates: {
        status?: string;
        tossOrderId?: string;
        filledPrice?: number;
        resolvedAt?: Date;
    },
) {
    return db
        .update(orderTracking)
        .set({
            ...updates,
            filledPrice: updates.filledPrice != null ? String(updates.filledPrice) : undefined,
        })
        .where(eq(orderTracking.idempotencyKey, idempotencyKey));
}

export async function getPendingSubmittedOrders(db: Db) {
    return db
        .select()
        .from(orderTracking)
        .where(eq(orderTracking.status, 'submitted'))
        .orderBy(orderTracking.submittedAt);
}
