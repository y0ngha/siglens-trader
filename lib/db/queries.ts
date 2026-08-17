import { eq, desc, and, gte, lte, sql, inArray, isNull } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from './index.js';
import type { NewsCardAnalysis } from '@y0ngha/siglens-core';
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
    cronRuns,
    cronDecisions,
    newsCards,
    notificationQueue,
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

// Default model when no analysis_model_config row exists. Keep in sync with src/pages/Settings.tsx MODELS[0].
const DEFAULT_ANALYSIS_MODEL = 'deepseek-v4-flash';

export async function getAnalysisConfig(db: Db, type: string) {
    const rows = await db
        .select()
        .from(analysisModelConfig)
        .where(eq(analysisModelConfig.analysisType, type))
        .limit(1);
    // No row = never configured → default to enabled with the default model (matches the
    // schema's `enabled.default(true)` and the dashboard's empty-state). This is fail-open by
    // design; live trading remains separately gated by trading_enabled (kill switch) + trading_mode
    // (defaults to dry_run), so a missing analysis row never causes unintended real orders.
    return (
        rows[0] ?? {
            id: 0,
            analysisType: type,
            enabled: true,
            modelId: DEFAULT_ANALYSIS_MODEL,
            useByok: false,
            updatedAt: new Date(),
        }
    );
}

export async function getAllAnalysisConfigs(db: Db) {
    return db.select().from(analysisModelConfig);
}

export async function updateAnalysisConfig(
    db: Db,
    type: string,
    updates: { modelId?: string; enabled?: boolean; useByok?: boolean },
) {
    const setValues = Object.fromEntries(
        Object.entries(updates).filter(([, v]) => v !== undefined),
    ) as Partial<typeof analysisModelConfig.$inferInsert>;
    return db
        .insert(analysisModelConfig)
        .values({
            analysisType: type,
            enabled: updates.enabled ?? true,
            modelId: updates.modelId ?? DEFAULT_ANALYSIS_MODEL,
            useByok: updates.useByok ?? false,
            updatedAt: new Date(),
        })
        .onConflictDoUpdate({
            target: analysisModelConfig.analysisType,
            set: { ...setValues, updatedAt: new Date() },
        });
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
        sourceAnalyzedAt?: Date;
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

export async function getAllLatestAnalysisResults(db: Db) {
    // PostgreSQL DISTINCT ON으로 (symbol, analysis_type)별 최신 1행만 DB에서 직접 추출.
    // 전체 스캔/메모리 dedup을 피해 누적 시 OOM·네트워크 폭증 방지.
    // idx_analysis_symbol_type_date 인덱스가 ORDER BY와 일치하여 효율적.
    return db
        .selectDistinctOn([analysisResults.symbol, analysisResults.analysisType])
        .from(analysisResults)
        .orderBy(
            analysisResults.symbol,
            analysisResults.analysisType,
            desc(analysisResults.analyzedAt),
        );
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
 * Only updates if the position is open and has **strictly more** shares than `soldQuantity`.
 * Returns true if the update matched a row, false otherwise.
 *
 * 동수량(`quantity === soldQuantity`)을 일부러 매칭하지 않는다. 종전 `>=`는 수량 0짜리
 * `open` 행을 남겼고, 그 행은 `planExit`이 항상 0을 돌려줘 `exit_deferred`가 영구
 * 반복되는 데다 `idx_positions_symbol_open` 때문에 그 심볼의 새 포지션도 열 수 없었다.
 * 호출부는 전부 동수량을 `closePosition`으로 보내며, 경합으로 그 사이 동수량이 된
 * 경우는 0행 → `POSITION_ALREADY_CLOSED` 롤백·재시도 경로가 받는다.
 */
export async function reducePositionQuantity(
    db: DbOrTx,
    id: number,
    soldQuantity: number,
): Promise<boolean> {
    const result = await db.execute(sql`
        UPDATE positions
        SET quantity = quantity - ${soldQuantity}
        WHERE id = ${id} AND status = 'open' AND quantity > ${soldQuantity}
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
): Promise<boolean> {
    const result = await db.execute(sql`
        UPDATE positions
        SET quantity = quantity + ${additionalQuantity},
            avg_price = ((quantity * avg_price::numeric + ${additionalQuantity} * ${additionalPrice}) / (quantity + ${additionalQuantity}))::text
        WHERE id = ${positionId} AND status = 'open'
        RETURNING id
    `);
    // 0행 매칭 = 조회와 UPDATE 사이에 포지션이 닫혔다(수동 청산·reconcile 복구·동시 실행).
    // 매도 경로는 예전부터 이걸 검사해 롤백하는데 매수만 빠져 있었다. 검사하지 않으면
    // trade 행과 order_tracking은 기록되고 포지션만 없는 상태가 되어, 그 주식은
    // `getOpenPositions`에 안 잡혀 **손절선도 익절선도 영원히 작동하지 않는다.**
    return ((result as { rowCount?: number } | null)?.rowCount ?? 0) > 0;
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

/**
 * 심볼별 마지막 **실제 체결** 시각 (`since` 이후). 재진입 쿨다운 전용.
 *
 * 종전에는 `getRecentTrades(db, 200)`를 받아 `mode='skipped'` 행을 코드에서 걸렀다.
 * 그런데 그 감사 행들은 200 슬롯을 그대로 차지한다 — 예산 0인 매수 신호는 종목마다
 * 매 틱 `quantity:0, mode:'skipped'` 행을 남기므로, 종목이 여럿이면 한 시간도 안 돼
 * 진짜 체결이 조회 창 밖으로 밀리고 쿨다운이 **조용히 꺼진다.** 집계를 DB로 내려
 * 슬롯 경쟁 자체를 없앤다.
 */
export async function getLastFillTimeBySymbol(db: Db, since: Date): Promise<Map<string, number>> {
    const rows = await db
        .select({
            symbol: trades.symbol,
            lastAt: sql<string>`max(${trades.executedAt})`,
        })
        .from(trades)
        .where(
            sql`${trades.mode} != 'skipped' AND ${trades.quantity} > 0 AND ${trades.executedAt} >= ${since}`,
        )
        .groupBy(trades.symbol);

    const map = new Map<string, number>();
    for (const row of rows) {
        const at = new Date(row.lastAt).getTime();
        if (Number.isFinite(at)) map.set(row.symbol, at);
    }
    return map;
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
 * Counts order_tracking rows created today (NY timezone) whose status is
 * 'submitted', 'pending', or 'partial'. These are orders that have been
 * submitted to the broker but not yet settled — they represent "in-flight"
 * orders that will eventually become trades but haven't been counted yet.
 * Used alongside getTodayTradeCount to prevent exceeding the daily trade limit.
 */
export async function getTodayInflightOrderCount(db: Db): Promise<number> {
    const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(orderTracking)
        .where(
            sql`${orderTracking.submittedAt} AT TIME ZONE 'America/New_York' >= date_trunc('day', now() AT TIME ZONE 'America/New_York')
                AND ${orderTracking.status} IN ('submitted', 'pending', 'partial', 'error')`,
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
/**
 * 오늘(뉴욕 기준) 실현 손익.
 *
 * `tradingMode`를 받는 이유: dry_run에서는 dry_run 체결이 **유일한** 실현 손익이다.
 * 이걸 제외하면 `todayPnl`이 항상 0이라 일일 손실 차단기의 실현 절반이 죽고, 리허설이
 * 실전보다 관대해진다 — 미실현 차단기는 dry_run에서도 도는데(의도된 설계) 실현만 빠지는
 * 비대칭이었다. 라이브 모드에서는 시뮬레이션 체결이 실계좌 차단기를 오염시키면 안 되므로
 * 종전대로 제외한다.
 */
export async function getTodayRealizedPnl(db: Db, tradingMode?: string): Promise<number> {
    const modeFilter =
        tradingMode === 'dry_run'
            ? sql`${trades.mode} != 'skipped'`
            : sql`${trades.mode} NOT IN ('skipped', 'dry_run')`;
    return getTodayRealizedPnlWhere(db, modeFilter);
}

async function getTodayRealizedPnlWhere(db: Db, modeFilter: SQL): Promise<number> {
    const rows = await db
        .select({
            pnl: sql<number>`COALESCE(SUM(${trades.realizedPnl}::numeric), 0)`,
        })
        .from(trades)
        .where(
            and(
                eq(trades.side, 'sell'),
                modeFilter,
                sql`${trades.realizedPnl} IS NOT NULL`,
                // NaN이 한 행이라도 섞이면 SUM 전체가 NaN이 되고, `NaN < -limit`은 항상
                // false라 그날 내내 차단기가 침묵한다. 손상된 행은 합계에서 뺀다.
                // (Postgres numeric은 IEEE와 달리 `'NaN' = 'NaN'`이 참이므로 등호로 거른다.)
                sql`${trades.realizedPnl}::numeric != 'NaN'::numeric`,
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

// Defaults used when a notification channel row does not yet exist (e.g. a fresh
// deploy where the seed never ran). Keep event keys in sync with the dashboard
// (src/pages/Settings.tsx NOTIFICATION_EVENTS).
const DEFAULT_NOTIFICATION_TARGET = 'dev.y0ngha@gmail.com';
const DEFAULT_NOTIFICATION_EVENTS = ['trade_executed', 'order_pending', 'stop_loss', 'error'];

export async function updateNotificationConfig(
    db: Db,
    channel: string,
    updates: { enabled?: boolean; target?: string; events?: string[] },
) {
    // Empty updates would make `DO UPDATE SET` empty (SQL error). Unreachable from
    // the dashboard (always ≥1 field), but guard against future regressions.
    if (Object.keys(updates).length === 0) return;
    // Upsert: a plain UPDATE silently no-ops when the row is missing, which made
    // the dashboard toggle appear broken. Insert a complete row on first write;
    // on conflict only the provided fields are written (partial update preserved).
    return db
        .insert(notificationConfig)
        .values({
            channel,
            enabled: updates.enabled ?? true,
            target: updates.target ?? DEFAULT_NOTIFICATION_TARGET,
            events: updates.events ?? DEFAULT_NOTIFICATION_EVENTS,
        })
        .onConflictDoUpdate({
            target: notificationConfig.channel,
            set: updates,
        });
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
    // upsert인 이유: `approve/[id].ts`는 `approve-{id}`라는 **고정** 멱등키를 쓴다. 1차 승인이
    // 브로커 오류로 실패해 대기 주문이 `pending`으로 되돌아가면, 재승인 시 순수 insert는
    // 유니크 위반으로 터지고 catch가 "Toss API 주문 실행 실패" 502를 반환한다 — Toss를
    // 호출조차 하지 않았는데. 그러면 그 주문은 TTL 만료까지 승인이 영구 불가다.
    // 같은 키의 재시도는 같은 주문의 새 시도이므로 행을 갱신하는 것이 맞다.
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
        .onConflictDoUpdate({
            target: orderTracking.idempotencyKey,
            set: {
                symbol: params.symbol,
                side: params.side,
                quantity: params.quantity,
                tossOrderId: params.tossOrderId,
                clientOrderId: params.clientOrderId,
                status: params.status,
                cronRunId: params.cronRunId,
                submittedAt: new Date(),
                resolvedAt: null,
            },
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

/**
 * 아직 결말이 확정되지 않은 주문 상태.
 *
 * `error`가 포함된 이유가 중요하다. Toss POST가 타임아웃되거나 `idempotency-key-conflict`를
 * 내면 execute는 `error`로 기록하고 끝나는데, **그 둘은 "브로커가 주문을 받지 않았다"는
 * 뜻이 아니다** — 특히 멱등키 충돌은 브로커가 이미 그 주문을 갖고 있다는 신호다. `error`를
 * 종료 상태로 빼 두면 (1) reconcile이 다시 묻지 않아 체결이 장부에서 사라지고
 * (2) 다음 틱이 in-flight 주문이 없다고 보고 **같은 심볼에 두 번째 주문**을 낸다.
 * 확정될 때까지는 in-flight로 취급하는 쪽이 양쪽 모두를 막는다.
 */
export const INFLIGHT_ORDER_STATUSES = ['submitted', 'pending', 'partial', 'error'] as const;

/**
 * 최근 `needs_review`로 종결된 주문의 심볼 목록.
 *
 * `needs_review`는 "브로커와 장부가 어긋났고 자동으로는 못 맞춘다"는 뜻이다 — 부분 체결
 * 타임아웃, 체결가 없는 복구 실패 등. 이 상태는 in-flight가 아니므로 다음 execute 틱은
 * 그 심볼을 **아무 주문도 없었던 것처럼** 본다: `existingSymbolExposure`가 0이고 체결 행이
 * 없어 `entry_cooldown`도 걸리지 않아, 이미 브로커에 주식이 있는 종목에 종목 예산 전액으로
 * 다시 매수한다. 사람이 정리할 때까지 신규 진입만 막는다(청산은 막지 않는다).
 */
export async function getNeedsReviewSymbols(db: Db, since: Date): Promise<string[]> {
    const rows = await db
        .selectDistinct({ symbol: orderTracking.symbol })
        .from(orderTracking)
        .where(
            sql`${orderTracking.status} = 'needs_review' AND ${orderTracking.submittedAt} >= ${since}`,
        );
    return rows.map((r) => r.symbol);
}

export async function getPendingSubmittedOrders(db: Db) {
    // 'pending'/'partial' are unfilled-in-flight states (not yet resolved) — treat as in-flight alongside 'submitted'.
    return db
        .select()
        .from(orderTracking)
        .where(inArray(orderTracking.status, [...INFLIGHT_ORDER_STATUSES]))
        .orderBy(orderTracking.submittedAt);
}

// ---------------------------------------------------------------------------
// Cron audit log
// ---------------------------------------------------------------------------

export type CronType =
    | 'technical'
    | 'news'
    | 'options'
    | 'fundamental'
    | 'congress'
    | 'execute'
    | 'reconcile'
    | 'digest';

export type CronOutcome =
    | 'completed'
    | 'market_closed'
    | 'us_market_holiday'
    | 'trading_disabled'
    | 'empty_watchlist'
    | 'locked'
    | 'disabled'
    | 'market_status_unavailable'
    | 'daily_trade_limit'
    | 'daily_loss_limit'
    | 'outside_entry_window'
    | 'timeout'
    | 'queue_empty';

/**
 * A cron audit row left in `running` for longer than this is considered stale
 * (its function timed out / was killed mid-run before it could write a finish
 * row). The reliability finalizer rewrites such rows to error/timeout so the
 * audit log never shows a perpetually-running invocation.
 *
 * Must stay greater than the longest a cron tick can run — the analysis crons stop
 * starting new work at 690s (see `_run-analysis-cron.ts`) and then finish in flight —
 * otherwise a live, still-running invocation could be swept mid-execution.
 */
/**
 * 30분인 이유: 이 값은 **가장 오래 걸릴 수 있는 크론 실행보다 커야 한다.** execute 한 번은
 * FMP가 429를 지속하면(호출당 최악 50초) 20분을 넘길 수 있다. 15분이던 시절에는 아직
 * 살아 있는 실행의 감사 행을 다음 크론이 `error/timeout`으로 덮어썼고, 그 실행이 끝나면
 * `finishCronRun`이 다시 `completed`로 덮어 `timeout` 값 자체가 신뢰할 수 없게 됐다.
 */
export const CRON_STALE_AFTER_MS = 30 * 60_000;

/**
 * Atomically finalize any `running` cron audit rows whose `started_at` is older
 * than {@link CRON_STALE_AFTER_MS}. Such rows belong to invocations that timed
 * out (Vercel maxDuration) before writing their own finish row, so they would
 * otherwise stay `running` forever.
 *
 * Best-effort: callers wrap this in their `[cron-audit]` safe() helper so a
 * failure never aborts the current cron. Concurrent calls are safe — after the
 * first UPDATE commits, no rows match the `status = 'running'` predicate.
 */
export async function finalizeStaleCronRuns(db: Db, now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - CRON_STALE_AFTER_MS);
    await db.execute(sql`
        UPDATE cron_runs
        SET status = 'error',
            outcome = 'timeout',
            finished_at = ${now},
            duration_ms = FLOOR(EXTRACT(EPOCH FROM (${now} - started_at)) * 1000),
            error = 'Cron exceeded maximum execution time'
        WHERE status = 'running'
          AND started_at < ${cutoff}
    `);
}

export async function startCronRun(
    db: Db,
    params: { runId: string; cronType: CronType; startedAt: Date },
) {
    return db
        .insert(cronRuns)
        .values({
            runId: params.runId,
            cronType: params.cronType,
            status: 'running',
            startedAt: params.startedAt,
        })
        .onConflictDoNothing();
}

export type CronRunFinish =
    | {
          status: 'completed';
          outcome: CronOutcome;
          summary?: unknown;
          durationMs?: number;
          finishedAt: Date;
      }
    | {
          status: 'skipped';
          outcome: CronOutcome;
          /** A skipped run can still have something worth recording — e.g. the digest
              finding cron-health issues on an otherwise empty queue. */
          summary?: unknown;
          durationMs?: number;
          finishedAt: Date;
      }
    | {
          status: 'error';
          error: string;
          outcome?: 'timeout';
          durationMs?: number;
          finishedAt: Date;
      };

export async function finishCronRun(db: Db, runId: string, p: CronRunFinish) {
    const set: Partial<typeof cronRuns.$inferInsert> = {
        status: p.status,
        durationMs: p.durationMs,
        finishedAt: p.finishedAt,
    };
    if (p.status === 'error') {
        set.error = p.error;
        // Error rows may carry a machine-readable outcome (e.g. 'timeout') so the
        // dashboard/alerts can distinguish a finalized stale run from a crash.
        if (p.outcome !== undefined) set.outcome = p.outcome;
    } else {
        set.outcome = p.outcome;
        if (p.summary !== undefined) {
            set.summary = p.summary as (typeof cronRuns.$inferInsert)['summary'];
        }
    }
    return db.update(cronRuns).set(set).where(eq(cronRuns.runId, runId));
}

export interface CronDecisionInput {
    symbol?: string;
    action: string;
    executed?: boolean;
    score?: number;
    reason?: string;
    detail?: unknown;
}

export async function insertCronDecisions(
    db: Db,
    runId: string,
    cronType: CronType,
    decisions: CronDecisionInput[],
) {
    if (decisions.length === 0) return;
    return db.insert(cronDecisions).values(
        decisions.map((d) => ({
            runId,
            cronType,
            symbol: d.symbol,
            action: d.action,
            executed: d.executed ?? false,
            score: d.score != null && Number.isFinite(d.score) ? String(d.score) : null,
            reason: d.reason,
            detail: d.detail,
        })),
    );
}

export async function getCronRuns(
    db: Db,
    filters: {
        cronType?: string;
        status?: string;
        from?: Date;
        to?: Date;
        limit?: number;
    } = {},
) {
    const conds = [];
    if (filters.cronType) conds.push(eq(cronRuns.cronType, filters.cronType));
    if (filters.status) conds.push(eq(cronRuns.status, filters.status));
    if (filters.from) conds.push(gte(cronRuns.startedAt, filters.from));
    if (filters.to) conds.push(lte(cronRuns.startedAt, filters.to));
    return db
        .select()
        .from(cronRuns)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(cronRuns.startedAt))
        .limit(Math.min(filters.limit ?? 200, 500));
}

export async function getCronDecisions(db: Db, runId: string) {
    return db
        .select()
        .from(cronDecisions)
        .where(eq(cronDecisions.runId, runId))
        .orderBy(desc(cronDecisions.createdAt));
}

// ---------------------------------------------------------------------------
// News cards (dedup persistence; PK newsId = URL SHA-256 from FmpNewsClient)
// ---------------------------------------------------------------------------

export async function getNewsCards(
    db: Db,
    newsIds: string[],
): Promise<Map<string, NewsCardAnalysis>> {
    if (newsIds.length === 0) return new Map();
    const rows = await db
        .select({ newsId: newsCards.newsId, card: newsCards.card })
        .from(newsCards)
        .where(inArray(newsCards.newsId, newsIds));
    return new Map(rows.map((r) => [r.newsId, r.card as NewsCardAnalysis]));
}

export async function upsertNewsCards(
    db: Db,
    rows: { newsId: string; symbol: string; card: NewsCardAnalysis; modelId: string }[],
): Promise<void> {
    if (rows.length === 0) return;
    await db.insert(newsCards).values(rows).onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Notification queue (quiet-hours deferrals → morning digest)
// ---------------------------------------------------------------------------

export async function enqueueNotification(
    db: Db,
    params: { kind: string; subject: string; html: string },
) {
    return db.insert(notificationQueue).values(params).returning();
}

/** Returns all rows with sentAt IS NULL (unsent), ordered by createdAt ascending. */
export async function getPendingNotifications(db: Db) {
    return db
        .select()
        .from(notificationQueue)
        .where(isNull(notificationQueue.sentAt))
        .orderBy(notificationQueue.createdAt);
}

/** Stamps sentAt on the given row ids so the digest cron won't re-send them. */
export async function markNotificationsSent(db: Db, ids: number[]) {
    if (ids.length === 0) return;
    return db
        .update(notificationQueue)
        .set({ sentAt: new Date() })
        .where(inArray(notificationQueue.id, ids));
}
