import { eq, desc, and, sql } from 'drizzle-orm';
import type { Db } from './index';
import {
    watchlist,
    analysisModelConfig,
    analysisResults,
    positions,
    trades,
    pendingOrders,
    config,
    notificationConfig,
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

export async function getLatestAnalysisResults(db: Db, symbol: string) {
    return db
        .select()
        .from(analysisResults)
        .where(eq(analysisResults.symbol, symbol))
        .orderBy(desc(analysisResults.analyzedAt));
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
    db: Db,
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

export async function closePosition(db: Db, id: number, closePrice: number) {
    return db
        .update(positions)
        .set({
            status: 'closed',
            closedAt: new Date(),
            closePrice: String(closePrice),
        })
        .where(eq(positions.id, id));
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export async function insertTrade(
    db: Db,
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

export async function getTodayTradeCount(db: Db) {
    const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(trades)
        .where(
            sql`${trades.executedAt} AT TIME ZONE 'America/New_York' >= date_trunc('day', now() AT TIME ZONE 'America/New_York')`,
        );
    return Number(rows[0]?.count ?? 0);
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
    return db.select().from(pendingOrders).where(eq(pendingOrders.status, 'pending'));
}

export async function getPendingOrderById(db: Db, id: number) {
    const rows = await db.select().from(pendingOrders).where(eq(pendingOrders.id, id)).limit(1);
    return rows[0] ?? null;
}

export async function approvePendingOrder(db: Db, id: number) {
    return db.update(pendingOrders).set({ status: 'approved' }).where(eq(pendingOrders.id, id));
}

export async function rejectPendingOrder(db: Db, id: number) {
    return db.update(pendingOrders).set({ status: 'rejected' }).where(eq(pendingOrders.id, id));
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
