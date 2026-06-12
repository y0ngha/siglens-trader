import { eq, desc, and, sql, inArray } from 'drizzle-orm';
import type { Db, DbOrTx } from './index.js';
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
} from './schema.js';

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
    return ((result as { rowCount?: number } | null)?.rowCount ?? 0) > 0;
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
        clientOrderId?: string;
        realizedPnl?: number;
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
            clientOrderId: params.clientOrderId,
            realizedPnl: params.realizedPnl != null ? String(params.realizedPnl) : undefined,
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
 * Returns today's realized PnL by summing the `realized_pnl` recorded on each
 * of today's sell trades.
 *
 * Realized PnL is now recorded per-sell-trade at execution time as
 * `(sellPrice − cost basis) × soldQuantity`, where cost basis is the closing
 * position's avgPrice at the moment of the sell. This function simply sums those
 * per-trade values for today's non-dry/non-skipped sells.
 *
 * This replaces the prior two-query approach (closed-position PnL + a
 * trades⋈positions join for partial sells), which could:
 *   - double-count a sell that both closed a position AND matched the open-join, and
 *   - misattribute PnL when a symbol was sold then re-opened the same day (the
 *     join picked up the *new* position's avgPrice).
 * Recording PnL at the sell site eliminates both classes of error.
 *
 * Excludes 'skipped' and 'dry_run' trades. Rows with a null `realized_pnl`
 * (sells booked before this column existed, or anomaly sells with no known
 * position) are excluded.
 *
 * Deploy-day caveat: sell trades booked before the realized_pnl column was
 * populated carry null and are skipped — a negligible one-day edge.
 *
 * Uses the typed Drizzle select builder (not db.execute) to ensure a stable
 * typed-array return shape regardless of the underlying driver. db.execute()
 * return shape varies by driver (raw array vs {rows:[...]}), which caused
 * rows[0] to be undefined → PnL silently always 0 → daily-loss breaker never
 * trips.
 */
export async function getTodayRealizedPnl(db: Db): Promise<number> {
    const rows = await db
        .select({
            pnl: sql<number>`COALESCE(SUM(${trades.realizedPnl}::numeric), 0)`,
        })
        .from(trades)
        .where(
            and(
                eq(trades.side, 'sell'),
                sql`${trades.mode} NOT IN ('skipped', 'dry_run')`,
                sql`${trades.realizedPnl} IS NOT NULL`,
                sql`${trades.executedAt} AT TIME ZONE 'America/New_York' >= date_trunc('day', now() AT TIME ZONE 'America/New_York')`,
            ),
        );
    return Number(rows[0]?.pnl ?? 0);
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
    db: DbOrTx,
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
    // 'pending'/'partial' are unfilled-in-flight states (not yet resolved) — treat as in-flight alongside 'submitted'.
    return db
        .select()
        .from(orderTracking)
        .where(inArray(orderTracking.status, ['submitted', 'pending', 'partial']))
        .orderBy(orderTracking.submittedAt);
}
