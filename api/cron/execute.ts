import crypto from 'node:crypto';
import { verifyCronSecret } from '../_lib/cron-auth.js';
import { getDb } from '../_lib/db.js';
import {
    getEnabledWatchlist,
    getConfigValue,
    getLatestAnalysisResult,
    getOpenPositions,
    getOpenPositionBySymbol,
    openPosition,
    closePosition,
    reducePositionQuantity,
    insertTrade,
    insertPendingOrder,
    getPendingOrders,
    getTodayTradeCount,
    getTodayInflightOrderCount,
    getTodayRealizedPnl,
    expireOldPendingOrders,
    createOrderTracking,
    updateOrderTracking,
    getPendingSubmittedOrders,
    averageIntoPosition,
    getNotificationConfig,
    enqueueNotification,
    startCronRun,
    finishCronRun,
    finalizeStaleCronRuns,
    insertCronDecisions,
    getAnalysisConfig,
} from '../../lib/db/queries.js';
import type { CronDecisionInput, CronRunFinish } from '../../lib/db/queries.js';
import { getAnalysisReferenceTime } from '../../lib/analysis/source-time.js';
import { getTechnicalMaxAgeMs, normalizeAnalysisTimeframe } from '../../lib/analysis/timeframe.js';
import { scoreSignals } from '../../lib/strategy/signal-scorer.js';
import { evaluateExistingPosition } from '../../lib/strategy/risk-manager.js';
import { planEntry, planExit } from '../../lib/strategy/trade-plan.js';
import type { EntryPlan, ExitTrigger } from '../../lib/strategy/trade-plan.js';
import { runTradeGate } from '../../lib/analysis/trade-gate.js';
import type {
    TradeGateAnalysisEntry,
    TradeGateKind,
    TradeGateOutcome,
} from '../../lib/analysis/trade-gate.js';
import { resolveApiKey } from './_run-analysis-cron.js';
import { makeTradeDecision } from '../../lib/strategy/decision.js';
import { executeBuyOrder, executeSellOrder } from '../../lib/trading/orders.js';
import { getBuyingPower, getSellableQuantity, isUsMarketOpen } from '../../lib/trading/account.js';
import { makeEmailGate } from '../../lib/notification/gate.js';
import { createEmailDispatcher } from '../../lib/notification/dispatch.js';
import {
    weightsForTimeframe,
    DEFAULT_BUY_THRESHOLD,
    DEFAULT_SELL_THRESHOLD,
} from '../../lib/strategy/types.js';
import type { ScoreWeights, SignalScore } from '../../lib/strategy/types.js';
import { acquireLock, releaseLock } from '../../lib/lock.js';
import { isEtRegularSessionOpen } from '@y0ngha/siglens-core';
import { fetchLivePrice, fetchLivePriceDetail } from '../../lib/data/live-price.js';
import type { LivePriceDetail } from '../../lib/data/live-price.js';
import { safeNumber } from '../../lib/validation.js';
import {
    safeRecord,
    safeString,
    safeAnalysisPrice,
    safeAnalysisTrend,
    safeAnalysisSentiment,
    safeAnalysisSupport,
    safeAnalysisResistance,
    safeAnalysisTargetPrice,
    safeArray,
    safeActionRecommendation,
    safeAnalysisIndicators,
    safeFundamentalCategories,
} from '../../lib/strategy/safe-extract.js';
import { realizedPnlForSell } from '../../lib/strategy/pnl.js';

type ExecuteDecision = CronDecisionInput & { symbol?: string; score: number };

function noPriceDetail(
    symbol: string,
    livePriceDetail: LivePriceDetail | undefined,
    technicalResult: unknown,
) {
    return {
        symbol,
        priceSources: {
            live: livePriceDetail ?? {
                source: 'fmp_quote',
                price: null,
                reason: 'not_available',
                error: 'FMP quote did not return a usable positive price',
            },
            analysisFallback: {
                source: 'technical.keyLevels.currentPrice',
                price: safeAnalysisPrice(technicalResult),
                usable: safeAnalysisPrice(technicalResult) > 0,
            },
        },
    };
}

/**
 * Audit detail recorded for every decision produced from a real signal score
 * (hold/buy/sell/average_in). Captures the component breakdown, the raw signal,
 * the active thresholds, and the source-analysis timestamp so a held or executed
 * decision can be explained after the fact.
 */
function scoreDecisionDetail(
    signalScore: SignalScore,
    buyThreshold: number,
    sellThreshold: number,
    sourceAnalyzedAt: Date | null,
) {
    // Guard against an Invalid Date (e.g. analysis row without a parseable
    // timestamp) — toISOString() would throw on a NaN-time Date.
    const sourceIso =
        sourceAnalyzedAt && Number.isFinite(sourceAnalyzedAt.getTime())
            ? sourceAnalyzedAt.toISOString()
            : null;
    return {
        components: signalScore.components,
        signal: signalScore.signal,
        thresholds: { buy: buyThreshold, sell: sellThreshold },
        sourceAnalyzedAt: sourceIso,
    };
}

/**
 * Where a sizing `fraction` came from. Recorded on every decision the gate took part in so
 * an audit can tell "the model chose half" from "the model was never asked".
 */
type GateSource = 'ai' | 'disabled' | 'hard' | 'error' | 'deadline';

/** Analysis rows the gate prompt reads, in the order `trade-gate.ts` renders them. */
const GATE_AXES: Array<TradeGateAnalysisEntry['type']> = [
    'technical',
    'news',
    'options',
    'fundamental',
    'congress',
];

type AnalysisRow = {
    result: unknown;
    modelId?: string | null;
    analyzedAt: Date | string;
    sourceAnalyzedAt?: Date | string | null;
} | null;

/**
 * Builds the gate's five-axis analysis block.
 *
 * A missing axis is passed through as `result: null` rather than dropped: `trade-gate.ts`
 * prints "데이터 없음" for it on purpose, and a silently absent section reads to the model as
 * "not applicable", which invites it to invent one.
 */
function toGateAnalyses(rows: Partial<Record<TradeGateAnalysisEntry['type'], AnalysisRow>>) {
    return GATE_AXES.map((type) => {
        const row = rows[type] ?? null;
        return {
            type,
            result: row?.result ?? null,
            // source_analyzed_at (the LLM's own stamp) wins over the row's write time —
            // same freshness clock the staleness guard above uses.
            analyzedAt: row ? getAnalysisReferenceTime(row) : null,
            modelId: row?.modelId ?? null,
        };
    });
}

/**
 * Audit block merged into `cron_decisions.detail` (design doc §9.3). Entry decisions carry the
 * budget that bounded them; exits have no buy budget, so those fields stay null.
 */
function gateDetail(params: {
    kind: TradeGateKind;
    source: GateSource;
    model: string;
    fraction: number;
    outcome: TradeGateOutcome | null;
    plan?: EntryPlan | null;
    quantity: number;
}) {
    const ok = params.outcome?.status === 'ok' ? params.outcome : null;
    return {
        gate: {
            kind: params.kind,
            source: params.source,
            model: params.model,
            fraction: params.fraction,
            confidence: ok?.confidence ?? null,
            reason:
                ok?.reason ??
                (params.outcome?.status === 'error' ? params.outcome.error : null) ??
                null,
            fullBudget: params.plan?.fullBudget ?? null,
            trancheBudget: params.plan?.trancheBudget ?? null,
            limitedBy: params.plan?.limitedBy ?? null,
            quantity: params.quantity,
        },
    };
}

function publicDecision(decision: ExecuteDecision) {
    return {
        symbol: decision.symbol,
        action: decision.action,
        score: decision.score,
        ...(decision.executed !== undefined ? { executed: decision.executed } : {}),
    };
}

async function handler(req: Request): Promise<Response> {
    if (!verifyCronSecret(req)) {
        return new Response('Unauthorized', { status: 401 });
    }

    // Audit helpers — best-effort, never abort trading
    const startedAt = new Date();
    const startedMs = startedAt.getTime();
    const cronRunId = `exec-${crypto.randomUUID()}`;
    const db = getDb();
    const safe = (p: Promise<unknown>) => p.catch((e) => console.error('[cron-audit]', e));
    const elapsed = () => ({ durationMs: Date.now() - startedMs, finishedAt: new Date() });

    // Finalize any audit rows stuck in 'running' past the stale threshold (a
    // prior invocation that timed out before writing its finish row). Best-effort.
    await safe(finalizeStaleCronRuns(db, startedAt));
    await safe(startCronRun(db, { runId: cronRunId, cronType: 'execute', startedAt }));

    let finishState: CronRunFinish | null = null;
    const decisions: ExecuteDecision[] = [];

    try {
        // Skip trade execution outside the U.S. regular session (cron schedule is a static approximation)
        if (!isEtRegularSessionOpen(new Date())) {
            finishState = { status: 'skipped', outcome: 'market_closed', ...elapsed() };
            return Response.json({ skipped: true, reason: 'market_closed' });
        }

        const LOCK_KEY = 'cron:execute:lock';
        // TTL < maxDuration(800s): a hung run holds the lock for its whole life (no mid-run expiry/overlap), and a killed fn's lock can't outlive it.
        const lockToken = await acquireLock(LOCK_KEY, 780);
        if (!lockToken) {
            finishState = { status: 'skipped', outcome: 'locked', ...elapsed() };
            return Response.json({ skipped: true, reason: 'another_execution_in_progress' });
        }

        try {
            // Email notification gate + dispatcher — respect the dashboard ON/OFF toggle,
            // per-event selection, configured recipient (A2), and quiet-hours deferral.
            // Legacy 'approval_required' is honored as an alias for 'order_pending'.
            // Defined early so circuit-breaker alerts below also go through the dispatcher.
            const emailNotif = (await getNotificationConfig(db)).find((n) => n.channel === 'email');
            const shouldEmail = makeEmailGate(emailNotif);
            const dispatcher = createEmailDispatcher({
                gate: shouldEmail,
                to: emailNotif?.target,
                enqueue: (row) => enqueueNotification(db, row),
            });
            // Error/safety alerts are gated on the 'error' (시스템 오류) event — same contract
            // as reconcile's notifyError, so "email OFF" suppresses every email uniformly.
            const notifyError = (subject: string, body: string) =>
                dispatcher.notifyError(subject, body).catch((e) => console.error('[email]', e));

            // Circuit breaker: kill switch
            const tradingEnabled = (await getConfigValue<boolean>(db, 'trading_enabled')) ?? true;
            if (!tradingEnabled) {
                finishState = { status: 'skipped', outcome: 'trading_disabled', ...elapsed() };
                return Response.json({ skipped: true, reason: 'trading_disabled' });
            }

            // Clean up expired pending orders
            await expireOldPendingOrders(db);

            // Circuit breaker: daily trade limit
            // Count both settled trades AND in-flight orders (submitted/pending/partial) so
            // concurrent/rapid runs cannot exceed the limit by racing before any order settles.
            const maxTradesPerDay = (await getConfigValue<number>(db, 'max_trades_per_day')) ?? 20;
            const [todayTradeCount, todayInflightCount] = await Promise.all([
                getTodayTradeCount(db),
                getTodayInflightOrderCount(db),
            ]);
            if (todayTradeCount + todayInflightCount >= maxTradesPerDay) {
                finishState = { status: 'skipped', outcome: 'daily_trade_limit', ...elapsed() };
                return Response.json({
                    skipped: true,
                    reason: 'daily_trade_limit_reached',
                    todayCount: todayTradeCount + todayInflightCount,
                    limit: maxTradesPerDay,
                });
            }

            // Circuit breaker: daily loss limit
            const maxDailyLoss = (await getConfigValue<number>(db, 'max_daily_loss_usd')) ?? 500;
            const todayPnl = await getTodayRealizedPnl(db);
            if (todayPnl < -maxDailyLoss) {
                await notifyError(
                    '일일 손실 한도 초과',
                    `오늘 실현 손실($${Math.abs(todayPnl).toFixed(2)})이 한도($${maxDailyLoss})를 초과하여 매매가 중지되었습니다.`,
                );
                finishState = { status: 'skipped', outcome: 'daily_loss_limit', ...elapsed() };
                return Response.json({
                    skipped: true,
                    reason: 'daily_loss_limit_reached',
                    todayPnl,
                    limit: maxDailyLoss,
                });
            }

            // Circuit breaker: unrealized loss limit
            // Fetch current prices for all open positions to calculate unrealized PnL.
            // Failures to fetch individual position prices are silently skipped (best-effort).
            const preCheckPositions = await getOpenPositions(db);
            if (preCheckPositions.length > 0) {
                let unrealizedPnl = 0;
                for (const pos of preCheckPositions) {
                    try {
                        const livePreCheck = await fetchLivePrice(pos.symbol).catch(() => null);
                        const techForPos = await getLatestAnalysisResult(
                            db,
                            pos.symbol,
                            'technical',
                        );
                        const curPrice = livePreCheck ?? safeAnalysisPrice(techForPos?.result);
                        if (curPrice > 0) {
                            const avgP = safeNumber(Number(pos.avgPrice), 0);
                            const dir = pos.side === 'short' ? avgP - curPrice : curPrice - avgP;
                            unrealizedPnl += dir * pos.quantity;
                        }
                    } catch {
                        // Skip this position's unrealized PnL — analysis data unavailable
                    }
                }
                const totalPnl = todayPnl + unrealizedPnl;
                if (totalPnl < -maxDailyLoss) {
                    await notifyError(
                        '일일 손실 한도 초과 (미실현 포함)',
                        `오늘 실현 손실($${Math.abs(todayPnl).toFixed(2)}) + 미실현 손실($${Math.abs(unrealizedPnl).toFixed(2)}) = 총 $${Math.abs(totalPnl).toFixed(2)}이 한도($${maxDailyLoss})를 초과하여 매매가 중지되었습니다.`,
                    );
                    finishState = {
                        status: 'skipped',
                        outcome: 'daily_loss_limit',
                        ...elapsed(),
                    };
                    return Response.json({
                        skipped: true,
                        reason: 'daily_loss_limit_reached',
                        todayPnl,
                        unrealizedPnl,
                        totalPnl,
                        limit: maxDailyLoss,
                    });
                }
            }

            // Load config
            const tradingMode = (await getConfigValue<string>(db, 'trading_mode')) ?? 'dry_run';
            const maxPositionSize = (await getConfigValue<number>(db, 'max_position_size')) ?? 1000;
            const maxTotalExposure =
                (await getConfigValue<number>(db, 'max_total_exposure')) ?? 5000;
            const buyThreshold =
                (await getConfigValue<number>(db, 'buy_threshold')) ?? DEFAULT_BUY_THRESHOLD;
            const sellThreshold =
                (await getConfigValue<number>(db, 'sell_threshold')) ?? DEFAULT_SELL_THRESHOLD;

            const stopLossPercent = (await getConfigValue<number>(db, 'stop_loss_percent')) ?? 5;
            const takeProfitPercent =
                (await getConfigValue<number>(db, 'take_profit_percent')) ?? 10;
            const fixedExitEnabled =
                (await getConfigValue<boolean>(db, 'fixed_exit_enabled')) ?? false;
            const analysisTimeframe = normalizeAnalysisTimeframe(
                await getConfigValue<unknown>(db, 'analysis_timeframe'),
            );
            const maxTechnicalAge = getTechnicalMaxAgeMs(analysisTimeframe);

            // Weights start from the profile for the timeframe being traded (slow signals
            // count for less the shorter the horizon), then any dashboard-configured value
            // overrides per key — an explicit setting must always win.
            //
            // Merging rather than `?? DEFAULT_WEIGHTS` also matters for correctness: the
            // stored row predates `congress`, so a whole-object fallback would leave that
            // weight `undefined` and make the weighted average NaN. NaN fails both the buy
            // and the sell comparison, so every symbol would silently sit at 'hold' and
            // trading would stop with nothing in the logs.
            const storedWeights = await getConfigValue<Partial<ScoreWeights>>(db, 'score_weights');
            const weights: ScoreWeights = {
                ...weightsForTimeframe(analysisTimeframe),
                ...(storedWeights ?? {}),
            };

            // U.S. market-holiday gating (non-dry-run only). isEtRegularSessionOpen already
            // gated by wall-clock at entry; this catches holidays the static schedule misses.
            if (tradingMode !== 'dry_run') {
                let marketOpen: boolean;
                try {
                    marketOpen = await isUsMarketOpen();
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    await notifyError(
                        '미국장 상태 조회 실패',
                        `브로커 시장 캘린더 조회에 실패하여 ${tradingMode} 주문 실행을 건너뜁니다.\n오류: ${message}`,
                    );
                    finishState = {
                        status: 'skipped',
                        outcome: 'market_status_unavailable',
                        ...elapsed(),
                    };
                    return Response.json({
                        skipped: true,
                        reason: 'market_status_unavailable',
                        error: message,
                    });
                }
                if (!marketOpen) {
                    finishState = {
                        status: 'skipped',
                        outcome: 'us_market_holiday',
                        ...elapsed(),
                    };
                    return Response.json({ skipped: true, reason: 'us-market-holiday' });
                }
            }

            // AI sizing gate config — read once per run. No row means never configured, and
            // getAnalysisConfig defaults that to enabled, so the gate is live the moment this
            // deploys (design doc §4). Turning it off in 설정 > 분석 설정 restores the old
            // all-or-nothing behavior with no redeploy.
            const gateConfig = await getAnalysisConfig(db, 'trade_gate');
            const gateApiKey = gateConfig.useByok ? resolveApiKey(gateConfig.modelId) : undefined;
            // Hard cutoff at start+600s. The lock TTL is 780s and the audit rows are written
            // after the loops, so a few slow gate calls late in a run must not eat the budget
            // that finalizing the audit needs — past this point we decide without the model.
            const gateDeadlineMs = startedMs + 600_000;

            const watchlistItems = await getEnabledWatchlist(db);

            // Calculate current exposure using current market prices when available,
            // falling back to avgPrice when no analysis data exists.
            const openPositions = await getOpenPositions(db);
            const pendingSubmittedOrders = await getPendingSubmittedOrders(db);

            if (watchlistItems.length === 0 && openPositions.length === 0) {
                finishState = { status: 'skipped', outcome: 'empty_watchlist', ...elapsed() };
                return Response.json({ skipped: true, reason: 'empty_watchlist' });
            }

            let currentExposure = 0;
            for (const p of openPositions) {
                let priceForExposure = safeNumber(Number(p.avgPrice), 0);
                try {
                    const liveExposure = await fetchLivePrice(p.symbol).catch(() => null);
                    if (liveExposure && liveExposure > 0) {
                        priceForExposure = liveExposure;
                    } else {
                        const techForExposure = await getLatestAnalysisResult(
                            db,
                            p.symbol,
                            'technical',
                        );
                        const marketPrice = safeAnalysisPrice(techForExposure?.result);
                        if (marketPrice > 0) priceForExposure = marketPrice;
                    }
                } catch {
                    // Fall back to avgPrice when analysis data is unavailable
                }
                currentExposure += priceForExposure * p.quantity;
            }

            // Track symbols closed by stop-loss in this cron run to prevent immediate re-buy
            const recentStopLossSymbols = new Set<string>();

            // --- Price cache: batch fetch all needed symbols once ---
            const priceCache = new Map<string, number>();
            const priceFailures = new Map<string, LivePriceDetail>();
            const allSymbols = new Set<string>();
            for (const p of openPositions) allSymbols.add(p.symbol);
            for (const w of watchlistItems) allSymbols.add(w.symbol);
            for (const order of pendingSubmittedOrders) allSymbols.add(order.symbol);
            for (const sym of allSymbols) {
                const detail = await fetchLivePriceDetail(sym).catch((err) => ({
                    source: 'fmp_quote' as const,
                    price: null,
                    reason: 'request_failed' as const,
                    error: err instanceof Error ? err.message : String(err),
                }));
                if (detail.price && detail.price > 0) {
                    priceCache.set(sym, detail.price);
                } else {
                    priceFailures.set(sym, detail);
                }
            }

            let pendingBuyExposure = 0;
            const pendingBuyExposureMissingPrice: string[] = [];
            for (const order of pendingSubmittedOrders) {
                if (
                    order.side !== 'buy' ||
                    !['submitted', 'pending', 'partial'].includes(order.status)
                ) {
                    continue;
                }

                let priceForPending = priceCache.get(order.symbol) ?? 0;
                if (priceForPending <= 0) {
                    try {
                        const techForPending = await getLatestAnalysisResult(
                            db,
                            order.symbol,
                            'technical',
                        );
                        priceForPending = safeAnalysisPrice(techForPending?.result);
                    } catch {
                        priceForPending = 0;
                    }
                }

                if (priceForPending > 0) {
                    pendingBuyExposure += priceForPending * order.quantity;
                } else {
                    pendingBuyExposureMissingPrice.push(order.symbol);
                }
            }
            currentExposure += pendingBuyExposure;

            // USD buying power, fetched once per invocation (auto mode only — guard not used in semi_auto).
            // null => fetch failed — fail CLOSED: all buy orders are skipped until the next run.
            const usdBuyingPower =
                tradingMode === 'auto' ? await getBuyingPower('USD').catch(() => null) : null;
            // Running balance: optimistically decremented after each live buy so multiple
            // buys in one run don't all authorize against the same un-decremented cash.
            // null => guard disabled. Reconcile/next-run corrects against broker reality.
            let remainingBuyingPower: number | null = usdBuyingPower;

            // --- Position re-evaluation ---
            for (const position of openPositions) {
                try {
                    // Skip position if there's a pending submitted sell order
                    const hasPendingSell = pendingSubmittedOrders.some(
                        (o) =>
                            o.symbol === position.symbol &&
                            o.side === 'sell' &&
                            ['submitted', 'pending', 'partial'].includes(o.status),
                    );
                    if (hasPendingSell) {
                        decisions.push({
                            symbol: position.symbol,
                            action: 'pending_sell_in_progress',
                            score: 0,
                        });
                        continue;
                    }

                    const [tech, news] = await Promise.all([
                        getLatestAnalysisResult(db, position.symbol, 'technical'),
                        getLatestAnalysisResult(db, position.symbol, 'news'),
                    ]);

                    // Staleness check: skip position if technical analysis is too old
                    const techReferenceTime = tech ? getAnalysisReferenceTime(tech) : null;
                    const techAge = techReferenceTime
                        ? Date.now() - techReferenceTime.getTime()
                        : Infinity;
                    if (techAge > maxTechnicalAge) {
                        decisions.push({
                            symbol: position.symbol,
                            action: 'stale_analysis',
                            score: 0,
                            detail: {
                                timeframe: analysisTimeframe,
                                maxAgeMs: maxTechnicalAge,
                                sourceAnalyzedAt: techReferenceTime?.toISOString() ?? null,
                            },
                        });
                        continue;
                    }

                    const techResult = tech?.result;
                    const currentPrice =
                        priceCache.get(position.symbol) ?? safeAnalysisPrice(techResult);
                    if (currentPrice <= 0) {
                        decisions.push({
                            symbol: position.symbol,
                            action: 'skipped_no_price',
                            score: 0,
                            detail: noPriceDetail(
                                position.symbol,
                                priceFailures.get(position.symbol),
                                techResult,
                            ),
                        });
                        await notifyError(
                            `가격 데이터 없음: ${position.symbol}`,
                            `${position.symbol} 포지션의 현재 가격을 확인할 수 없어 평가를 건너뛰었습니다. 수동 확인이 필요합니다.`,
                        );
                        continue;
                    }

                    const evaluation = evaluateExistingPosition({
                        avgPrice: safeNumber(Number(position.avgPrice), 0),
                        currentPrice,
                        stopLossPercent,
                        takeProfitPercent,
                        fixedExitEnabled,
                        supportLevel: safeAnalysisSupport(techResult),
                        resistanceLevel: safeAnalysisResistance(techResult),
                        targetPrice: safeAnalysisTargetPrice(techResult),
                        technicalTrend: safeAnalysisTrend(techResult),
                        newsSentiment: safeAnalysisSentiment(news?.result),
                    });

                    if (evaluation.action === 'hold') {
                        decisions.push({
                            symbol: position.symbol,
                            action: 'hold',
                            score: 0,
                            executed: false,
                            reason: evaluation.reason,
                        });
                        continue;
                    }

                    // Track stop-loss closures to prevent same-run re-buy. Registered on the
                    // *trigger*, not on how much actually gets sold: a partial stop-loss is
                    // not a safer reason to re-buy the same symbol minutes later — the thesis
                    // that tripped the stop is unchanged either way.
                    if (evaluation.action === 'stop_loss') {
                        recentStopLossSymbols.add(position.symbol);
                    }

                    // --- Exit sizing gate ---
                    // Exits are fail-OPEN: any gate problem sells the full position. Failing to
                    // buy costs an opportunity, failing to sell costs realized money, so a
                    // provider outage must never leave a stop-loss signal holding the bag.
                    const exitTrigger: ExitTrigger =
                        evaluation.action === 'stop_loss' ? 'stop_loss' : 'take_profit';
                    let exitFraction = 1;
                    let exitGateSource: GateSource = 'disabled';
                    let exitOutcome: TradeGateOutcome | null = null;
                    if (evaluation.hard === true) {
                        // Corrupt price data or the operator's fixed stop line — absolute risk
                        // controls, not a call for the model to soften (design doc §6).
                        exitGateSource = 'hard';
                    } else if (!gateConfig.enabled) {
                        exitGateSource = 'disabled';
                    } else if (Date.now() > gateDeadlineMs) {
                        exitGateSource = 'deadline';
                        await notifyError(
                            `게이트 컷오프: ${position.symbol}`,
                            `실행 시작 후 600초를 넘겨 청산 사이징 게이트를 건너뛰고 전량 청산합니다.`,
                        );
                    } else {
                        // The remaining three axes are read only here: on hold / hard-exit /
                        // gate-off paths nothing consumes them, so fetching them up front
                        // would be three wasted queries per position on every tick.
                        const [options, fundamental, congress] = await Promise.all([
                            getLatestAnalysisResult(db, position.symbol, 'options'),
                            getLatestAnalysisResult(db, position.symbol, 'fundamental'),
                            getLatestAnalysisResult(db, position.symbol, 'congress'),
                        ]);
                        exitOutcome = await runTradeGate({
                            kind: 'exit',
                            symbol: position.symbol,
                            price: currentPrice,
                            priceSource: priceCache.has(position.symbol)
                                ? 'live'
                                : 'analysis_fallback',
                            decidedAt: new Date(),
                            account: {
                                availableCashUsd: remainingBuyingPower,
                                maxPositionSize,
                                symbolExposure: currentPrice * position.quantity,
                                currentExposure,
                                maxTotalExposure,
                                todayRealizedPnl: todayPnl,
                                maxDailyLossUsd: maxDailyLoss,
                                todayTradeCount: todayTradeCount + todayInflightCount,
                                maxTradesPerDay,
                                tradingMode,
                            },
                            // This path never scores signals — it re-evaluates a held position.
                            signal: null,
                            position: {
                                quantity: position.quantity,
                                avgPrice: safeNumber(Number(position.avgPrice), 0),
                            },
                            budget: null,
                            exit: { trigger: exitTrigger, ruleReason: evaluation.reason },
                            analyses: toGateAnalyses({
                                technical: tech,
                                news,
                                options,
                                fundamental,
                                congress,
                            }),
                            modelId: gateConfig.modelId,
                            userApiKey: gateApiKey,
                            correlationId: `${cronRunId}-${position.symbol}-exit`,
                        });
                        if (exitOutcome.status === 'ok') {
                            exitFraction = exitOutcome.fraction;
                            exitGateSource = 'ai';
                        } else {
                            exitGateSource = 'error';
                            await notifyError(
                                `청산 게이트 실패: ${position.symbol}`,
                                `사이징 게이트 오류로 전량 청산합니다 (fail-open).\n오류: ${exitOutcome.error}`,
                            );
                        }
                    }

                    const exitQty = planExit({
                        positionQuantity: position.quantity,
                        fraction: exitFraction,
                        trigger: exitTrigger,
                        hard: evaluation.hard,
                    });
                    const exitDetail = gateDetail({
                        kind: 'exit',
                        source: exitGateSource,
                        model: gateConfig.modelId,
                        fraction: exitFraction,
                        outcome: exitOutcome,
                        quantity: exitQty,
                    });

                    if (exitQty === 0) {
                        // fraction 0 is a deliberate "not this tick" call, not a failure — the
                        // position stays open and the next tick re-evaluates. No email.
                        decisions.push({
                            symbol: position.symbol,
                            action: 'exit_deferred',
                            score: 0,
                            executed: false,
                            reason: evaluation.reason,
                            detail: exitDetail,
                        });
                        continue;
                    }

                    // Execute the exit
                    let decisionPushed = false;
                    switch (tradingMode) {
                        case 'dry_run':
                            try {
                                await db.transaction(async (tx) => {
                                    // Partial exits leave the position open — only a full-size
                                    // exit closes it.
                                    if (exitQty >= position.quantity) {
                                        const closed = await closePosition(
                                            tx,
                                            position.id,
                                            currentPrice,
                                        );
                                        if (!closed) throw new Error('POSITION_ALREADY_CLOSED');
                                    } else {
                                        await reducePositionQuantity(tx, position.id, exitQty);
                                    }
                                    await insertTrade(tx, {
                                        symbol: position.symbol,
                                        side: 'sell',
                                        orderType: 'market',
                                        quantity: exitQty,
                                        price: currentPrice,
                                        executedAt: new Date(),
                                        reason: evaluation.reason,
                                        mode: 'dry_run',
                                        cronRunId,
                                        realizedPnl: realizedPnlForSell(
                                            currentPrice,
                                            Number(position.avgPrice),
                                            exitQty,
                                        ),
                                    });
                                });
                                // A1: notify on dry_run fills, mirroring the auto exit path.
                                // Stop-loss exits honor the 'stop_loss' checkbox; all others
                                // use 'trade_executed' — same routing as the auto branch below.
                                {
                                    const dryExitEvent =
                                        evaluation.action === 'stop_loss'
                                            ? ('stop_loss' as const)
                                            : ('trade_executed' as const);
                                    await dispatcher
                                        .notifyTradeExecuted(
                                            {
                                                symbol: position.symbol,
                                                side: 'sell',
                                                quantity: exitQty,
                                                price: currentPrice,
                                                reason: evaluation.reason,
                                                mode: 'dry_run',
                                            },
                                            dryExitEvent,
                                        )
                                        .catch((err) => console.error('[email] send failed:', err));
                                }
                                currentExposure -= currentPrice * exitQty;
                                if (currentExposure < 0) currentExposure = 0;
                            } catch (txErr) {
                                if (
                                    txErr instanceof Error &&
                                    txErr.message === 'POSITION_ALREADY_CLOSED'
                                ) {
                                    decisions.push({
                                        symbol: position.symbol,
                                        action: 'already_closed',
                                        score: 0,
                                    });
                                    decisionPushed = true;
                                } else {
                                    throw txErr;
                                }
                            }
                            break;

                        case 'semi_auto':
                            await insertPendingOrder(db, {
                                symbol: position.symbol,
                                side: 'sell',
                                quantity: exitQty,
                                priceLimit: currentPrice,
                                analysisSummary: evaluation.reason,
                                signalScore: 0,
                                expiresAt: new Date(Date.now() + 15 * 60 * 1000),
                            });
                            await dispatcher
                                .notifyApprovalRequest({
                                    symbol: position.symbol,
                                    side: 'sell',
                                    quantity: exitQty,
                                    score: 0,
                                    reason: evaluation.reason,
                                    approveUrl: 'https://auto-trade.siglens.io/pending',
                                })
                                .catch((err) => console.error('[email] send failed:', err));
                            // Pending order awaits human approval — NOT a fill.
                            decisions.push({
                                symbol: position.symbol,
                                action: evaluation.action,
                                score: 0,
                                executed: false,
                                detail: exitDetail,
                            });
                            decisionPushed = true;
                            break;

                        case 'auto': {
                            // Sellable-quantity guard: confirm broker holds enough shares.
                            // Starts from the gate-sized quantity; the broker clamp below can
                            // only shrink it further.
                            let sellQty = exitQty;
                            const sellable = await getSellableQuantity(position.symbol).catch(
                                () => null,
                            );
                            if (sellable != null) {
                                // Clamp first, then reject — a fractional sellable (0<x<1)
                                // floors to 0 and must not produce a 0-qty order.
                                const clamped = Math.min(sellQty, Math.floor(sellable));
                                if (clamped <= 0) {
                                    decisions.push({
                                        symbol: position.symbol,
                                        action: 'skipped_not_sellable',
                                        score: 0,
                                    });
                                    decisionPushed = true;
                                    break;
                                }
                                sellQty = clamped;
                            }
                            const exitIdempotencyKey = `${cronRunId}-${position.symbol}-sell`;
                            const clientOrderId = crypto.randomUUID();
                            await createOrderTracking(db, {
                                idempotencyKey: exitIdempotencyKey,
                                clientOrderId,
                                symbol: position.symbol,
                                side: 'sell',
                                quantity: sellQty,
                                status: 'submitted',
                                cronRunId,
                            });
                            let orderResult;
                            try {
                                orderResult = await executeSellOrder(
                                    position.symbol,
                                    sellQty,
                                    clientOrderId,
                                );
                            } catch (apiErr) {
                                await updateOrderTracking(db, exitIdempotencyKey, {
                                    status: 'error',
                                    resolvedAt: new Date(),
                                }).catch(() => {});
                                throw apiErr;
                            }
                            // Early status write for non-filled outcomes only. For 'filled' the
                            // ONLY status write happens inside the booking tx (clean fill) or the
                            // needs_review write below — never here — so 'filled' can't exist
                            // without its trade.
                            if (orderResult.status !== 'filled') {
                                const exitResolved =
                                    orderResult.status !== 'pending' &&
                                    orderResult.status !== 'partial';
                                await updateOrderTracking(db, exitIdempotencyKey, {
                                    tossOrderId: orderResult.orderId || undefined,
                                    status: orderResult.status,
                                    filledPrice: orderResult.avgFilledPrice ?? undefined,
                                    resolvedAt: exitResolved ? new Date() : undefined,
                                });
                            }
                            if (
                                orderResult.status === 'rejected' ||
                                orderResult.status === 'canceled'
                            ) {
                                decisions.push({
                                    symbol: position.symbol,
                                    action: 'order_rejected',
                                    score: 0,
                                });
                                decisionPushed = true;
                                await notifyError(
                                    `주문 거부: ${position.symbol}`,
                                    orderResult.rejectReason ?? '거부 사유 없음',
                                );
                                break;
                            }
                            // pending/partial: NO trade, NO position mutation, NO exposure change.
                            // Reconcile owns final booking (single source of truth → no double-count).
                            // partial differs only in tracking status + notification text.
                            if (
                                orderResult.status === 'pending' ||
                                orderResult.status === 'partial'
                            ) {
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
                                decisions.push({
                                    symbol: position.symbol,
                                    action:
                                        orderResult.status === 'partial'
                                            ? 'order_partial'
                                            : 'order_submitted',
                                    score: 0,
                                });
                                decisionPushed = true;
                                break;
                            }
                            // status === 'filled' — auto-book ONLY a clean full fill:
                            // broker filled qty == intended integer qty (within epsilon) AND a
                            // real fill price is present. Any other outcome (short/fractional
                            // fill or missing price) is routed to needs_review (no auto-book).
                            const filledQ = orderResult.filledQuantity ?? sellQty;
                            const cleanFullFill =
                                orderResult.avgFilledPrice != null &&
                                Number.isInteger(sellQty) &&
                                Math.abs(filledQ - sellQty) < 1e-6;
                            if (!cleanFullFill) {
                                // 단축/소수점 체결 또는 체결가 누락 → 자동 기록하지 않고 수동 검토로
                                await updateOrderTracking(db, exitIdempotencyKey, {
                                    status: 'needs_review',
                                    filledPrice: orderResult.avgFilledPrice ?? undefined,
                                    resolvedAt: new Date(),
                                });
                                await notifyError(
                                    `체결 수동확인 필요: ${position.symbol}`,
                                    `sell 주문이 예상과 다르게 체결됨 (의도 ${sellQty}주, 체결 ${filledQ}, 체결가 ${orderResult.avgFilledPrice ?? '없음'}). 수동 기록 필요.`,
                                ).catch((e) => console.error('[email]', e));
                                decisions.push({
                                    symbol: position.symbol,
                                    action: 'needs_review',
                                    score: 0,
                                });
                                decisionPushed = true;
                                break;
                            }
                            const filledSellPrice = orderResult.avgFilledPrice!;
                            const actualExitQty = sellQty;
                            try {
                                await db.transaction(async (tx) => {
                                    if (actualExitQty >= position.quantity) {
                                        const closed = await closePosition(
                                            tx,
                                            position.id,
                                            filledSellPrice,
                                        );
                                        if (!closed) throw new Error('POSITION_ALREADY_CLOSED');
                                    } else {
                                        await reducePositionQuantity(
                                            tx,
                                            position.id,
                                            actualExitQty,
                                        );
                                    }
                                    await insertTrade(tx, {
                                        symbol: position.symbol,
                                        side: 'sell',
                                        orderType: 'market',
                                        quantity: actualExitQty,
                                        price: filledSellPrice,
                                        executedAt: new Date(),
                                        reason: evaluation.reason,
                                        mode: 'auto',
                                        cronRunId,
                                        clientOrderId,
                                        realizedPnl: realizedPnlForSell(
                                            filledSellPrice,
                                            Number(position.avgPrice),
                                            actualExitQty,
                                        ),
                                    });
                                    // ATOMIC: mark filled inside the same tx so 'filled' never
                                    // exists without its trade (double-book race guard).
                                    await updateOrderTracking(tx, exitIdempotencyKey, {
                                        tossOrderId: orderResult.orderId || undefined,
                                        status: 'filled',
                                        filledPrice: filledSellPrice,
                                        resolvedAt: new Date(),
                                    });
                                });
                                currentExposure -= filledSellPrice * actualExitQty;
                            } catch (txErr) {
                                if (
                                    txErr instanceof Error &&
                                    txErr.message === 'POSITION_ALREADY_CLOSED'
                                ) {
                                    decisions.push({
                                        symbol: position.symbol,
                                        action: 'already_closed',
                                        score: 0,
                                    });
                                    decisionPushed = true;
                                    break;
                                }
                                throw txErr;
                            }
                            if (currentExposure < 0) currentExposure = 0;
                            // Route the exit to the matching event: stop-loss closures honor the
                            // 'stop_loss' checkbox, all other exits (take-profit / AI sell) honor
                            // 'trade_executed' — so each checkbox is meaningful on the exit path.
                            {
                                const exitEvent =
                                    evaluation.action === 'stop_loss'
                                        ? ('stop_loss' as const)
                                        : ('trade_executed' as const);
                                await dispatcher
                                    .notifyTradeExecuted(
                                        {
                                            symbol: position.symbol,
                                            side: 'sell',
                                            quantity: actualExitQty,
                                            price: filledSellPrice,
                                            reason: evaluation.reason,
                                            mode: 'auto',
                                        },
                                        exitEvent,
                                    )
                                    .catch((err) => console.error('[email] send failed:', err));
                            }
                            break;
                        }
                    }

                    if (!decisionPushed) {
                        decisions.push({
                            symbol: position.symbol,
                            action: evaluation.action,
                            score: 0,
                            executed: true,
                            detail: exitDetail,
                        });
                    }
                } catch (err) {
                    await notifyError(position.symbol, String(err));
                    decisions.push({ symbol: position.symbol, action: 'error', score: 0 });
                }
            }

            // Recalculate exposure after position closures using cached market prices
            const updatedPositions = await getOpenPositions(db);
            currentExposure = 0;
            for (const p of updatedPositions) {
                let priceForRecalc = safeNumber(Number(p.avgPrice), 0);
                const cachedRecalc = priceCache.get(p.symbol);
                if (cachedRecalc && cachedRecalc > 0) {
                    priceForRecalc = cachedRecalc;
                } else {
                    try {
                        const techForRecalc = await getLatestAnalysisResult(
                            db,
                            p.symbol,
                            'technical',
                        );
                        const recalcPrice = safeAnalysisPrice(techForRecalc?.result);
                        if (recalcPrice > 0) priceForRecalc = recalcPrice;
                    } catch {
                        // Fall back to avgPrice when analysis data is unavailable
                    }
                }
                currentExposure += priceForRecalc * p.quantity;
            }
            currentExposure += pendingBuyExposure;

            for (const item of watchlistItems) {
                try {
                    // Gather latest analysis results
                    const [tech, news, options, fundamental, congress] = await Promise.all([
                        getLatestAnalysisResult(db, item.symbol, 'technical'),
                        getLatestAnalysisResult(db, item.symbol, 'news'),
                        getLatestAnalysisResult(db, item.symbol, 'options'),
                        getLatestAnalysisResult(db, item.symbol, 'fundamental'),
                        getLatestAnalysisResult(db, item.symbol, 'congress'),
                    ]);

                    // Staleness check: skip symbol if technical analysis is too old
                    const techReferenceTime = tech ? getAnalysisReferenceTime(tech) : null;
                    const techAge = techReferenceTime
                        ? Date.now() - techReferenceTime.getTime()
                        : Infinity;
                    if (techAge > maxTechnicalAge) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'stale_analysis',
                            score: 0,
                            detail: {
                                timeframe: analysisTimeframe,
                                maxAgeMs: maxTechnicalAge,
                                sourceAnalyzedAt: techReferenceTime?.toISOString() ?? null,
                            },
                        });
                        continue;
                    }

                    // Score signals — build type-safe inputs from untyped AI results
                    const signalInputs = {
                        technical: tech?.result
                            ? {
                                  trend: safeAnalysisTrend(tech.result),
                                  riskLevel: safeString(safeRecord(tech.result)?.riskLevel),
                                  actionRecommendation: safeActionRecommendation(tech.result),
                                  indicators: safeAnalysisIndicators(tech.result),
                              }
                            : null,
                        news: news?.result
                            ? {
                                  overallSentiment: safeAnalysisSentiment(news.result),
                              }
                            : null,
                        options: options?.result
                            ? {
                                  signals: safeArray(options.result, 'signals') as
                                      | Array<{ kind?: string }>
                                      | undefined,
                              }
                            : null,
                        fundamental: fundamental?.result
                            ? {
                                  overallSentiment: safeAnalysisSentiment(fundamental.result),
                                  categories: safeFundamentalCategories(fundamental.result),
                              }
                            : null,
                        congress: congress?.result
                            ? { overallSentiment: safeAnalysisSentiment(congress.result) }
                            : null,
                    };
                    const signalScore = scoreSignals(
                        signalInputs,
                        weights,
                        buyThreshold,
                        sellThreshold,
                    );

                    // Position + pricing
                    const existingPosition = await getOpenPositionBySymbol(db, item.symbol);
                    const currentPrice =
                        priceCache.get(item.symbol) ?? safeAnalysisPrice(tech?.result);

                    if (currentPrice <= 0) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'skipped_no_price',
                            score: 0,
                            detail: noPriceDetail(
                                item.symbol,
                                priceFailures.get(item.symbol),
                                tech?.result,
                            ),
                        });
                        continue;
                    }

                    // Budget ceiling for this symbol, before the gate applies any fraction.
                    // planEntry folds in the per-symbol cap, the total-exposure cap and (auto
                    // only) real cash, which is why the old average_in-specific cap block that
                    // used to live further down is gone — it was the same arithmetic twice.
                    const existingSymbolExposure = existingPosition
                        ? currentPrice * existingPosition.quantity
                        : 0;
                    const entryPlanInputs = {
                        price: currentPrice,
                        maxPositionSize,
                        maxTotalExposure,
                        currentExposure,
                        existingSymbolExposure,
                        // dry_run/semi_auto never query the broker, so cash is unknown there
                        // (null) and must not constrain the plan.
                        availableCash: remainingBuyingPower,
                    };
                    const maxPlan = planEntry({ ...entryPlanInputs, fraction: 1 });

                    // Per-symbol cap exhausted on a symbol we already hold. This has to run
                    // *before* makeTradeDecision: afterwards the decision is 'hold' with
                    // calculatedSize 0, which falls into the '잔고 부족' branch below and mails
                    // the operator about the total-exposure limit when the real cause is the
                    // per-symbol one. Restricted to buy signals so a sell/hold on a fully
                    // funded symbol still takes its normal path.
                    if (
                        existingPosition &&
                        signalScore.signal === 'buy' &&
                        maxPlan.quantity === 0
                    ) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'symbol_limit_reached',
                            score: signalScore.total,
                        });
                        continue;
                    }

                    // Circuit breaker: re-check daily trade limit before each trade
                    // Include in-flight orders to prevent limit overshoot across concurrent runs.
                    const [currentDayCount, currentInflightCount] = await Promise.all([
                        getTodayTradeCount(db),
                        getTodayInflightOrderCount(db),
                    ]);
                    if (currentDayCount + currentInflightCount >= maxTradesPerDay) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'daily_limit',
                            score: 0,
                        });
                        continue;
                    }

                    // Make decision
                    let decision = makeTradeDecision({
                        symbol: item.symbol,
                        signalScore,
                        hasOpenPosition: !!existingPosition,
                        positionQuantity: existingPosition?.quantity ?? 0,
                        calculatedSize: maxPlan.quantity,
                    });

                    // Stop-loss cooldown: skip buy signals for symbols closed by stop-loss in this run
                    if (
                        (decision.action === 'buy' || decision.action === 'average_in') &&
                        recentStopLossSymbols.has(item.symbol)
                    ) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'cooldown_after_stop_loss',
                            score: decision.score,
                        });
                        continue;
                    }

                    // Pending sell guard: skip sell if there's a submitted sell order in flight
                    if (decision.action === 'sell') {
                        const hasPendingSellWatch = pendingSubmittedOrders.some(
                            (o) =>
                                o.symbol === item.symbol &&
                                o.side === 'sell' &&
                                ['submitted', 'pending', 'partial'].includes(o.status),
                        );
                        if (hasPendingSellWatch) {
                            decisions.push({
                                symbol: item.symbol,
                                action: 'pending_sell_in_progress',
                                score: decision.score,
                            });
                            continue;
                        }
                    }

                    // Pending buy guard: skip buy/average_in if an in-flight buy order exists
                    // for this symbol. With per-run random clientOrderIds, re-submitting an
                    // unfilled (pending/partial/submitted) buy would double-submit.
                    if (decision.action === 'buy' || decision.action === 'average_in') {
                        const hasPendingBuy = pendingSubmittedOrders.some(
                            (o) =>
                                o.symbol === item.symbol &&
                                o.side === 'buy' &&
                                ['submitted', 'pending', 'partial'].includes(o.status),
                        );
                        if (hasPendingBuy) {
                            decisions.push({
                                symbol: item.symbol,
                                action: 'pending_order_in_progress',
                                score: decision.score,
                            });
                            continue;
                        }
                    }

                    // Sell without position guard: no phantom trade when no position exists
                    if (decision.action === 'sell' && !existingPosition) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'no_position_to_sell',
                            score: decision.score,
                        });
                        continue;
                    }

                    // Insufficient balance — signal is buy but position size is 0
                    if (
                        decision.action === 'hold' &&
                        signalScore.signal === 'buy' &&
                        maxPlan.quantity === 0
                    ) {
                        await insertTrade(db, {
                            symbol: item.symbol,
                            side: 'buy',
                            orderType: 'market',
                            quantity: 0,
                            price: currentPrice,
                            executedAt: new Date(),
                            reason: `잔고 부족 — 신호 ${signalScore.total}/100 매수 신호 발생했으나 최대 노출 한도 초과로 미실행`,
                            mode: 'skipped',
                            cronRunId,
                        });

                        await notifyError(
                            `잔고 부족: ${item.symbol}`,
                            `${item.symbol} 매수 신호 (${signalScore.total}/100) 발생했으나 잔고 부족으로 미실행.\n현재 총 노출: $${currentExposure.toFixed(2)} / 한도: $${maxTotalExposure}`,
                        );

                        decisions.push({
                            symbol: item.symbol,
                            action: 'skipped',
                            score: signalScore.total,
                        });
                        continue;
                    }

                    if (decision.action === 'hold') {
                        decisions.push({
                            symbol: item.symbol,
                            action: decision.action,
                            score: decision.score,
                            executed: false,
                            reason: decision.reason,
                            detail: scoreDecisionDetail(
                                signalScore,
                                buyThreshold,
                                sellThreshold,
                                techReferenceTime,
                            ),
                        });
                        continue;
                    }

                    // Kill switch guard: re-read volatile config before each trade.
                    // trading_mode is snapshot at run start — only the kill switch is re-read
                    // to allow immediate halt without mid-run mode drift.
                    const currentTradingEnabled =
                        (await getConfigValue<boolean>(db, 'trading_enabled')) ?? true;
                    if (!currentTradingEnabled) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'trading_disabled_mid_loop',
                            score: decision.score,
                        });
                        continue;
                    }

                    // --- Sizing gate ---
                    // Deliberately last: every rule-engine guard above (stop-loss cooldown,
                    // in-flight orders, phantom sell, kill switch, daily limits) has already
                    // run, so an LLM call only happens on a path that is actually going to
                    // place an order.
                    const scoreDetail = scoreDecisionDetail(
                        signalScore,
                        buyThreshold,
                        sellThreshold,
                        techReferenceTime,
                    );
                    const gateAnalyses = toGateAnalyses({
                        technical: tech,
                        news,
                        options,
                        fundamental,
                        congress,
                    });
                    const gateAccount = {
                        availableCashUsd: remainingBuyingPower,
                        maxPositionSize,
                        symbolExposure: existingSymbolExposure,
                        currentExposure,
                        maxTotalExposure,
                        todayRealizedPnl: todayPnl,
                        maxDailyLossUsd: maxDailyLoss,
                        todayTradeCount: currentDayCount + currentInflightCount,
                        maxTradesPerDay,
                        tradingMode,
                    };
                    const gateSignal = {
                        total: signalScore.total,
                        signal: signalScore.signal,
                        components: signalScore.components,
                        weights,
                        buyThreshold,
                        sellThreshold,
                        sourceAnalyzedAt: techReferenceTime,
                    };
                    const gatePosition = existingPosition
                        ? {
                              quantity: existingPosition.quantity,
                              avgPrice: safeNumber(Number(existingPosition.avgPrice), 0),
                          }
                        : null;
                    const gateCommon = {
                        symbol: item.symbol,
                        companyName: item.companyName ?? undefined,
                        price: currentPrice,
                        priceSource: priceCache.has(item.symbol)
                            ? ('live' as const)
                            : ('analysis_fallback' as const),
                        decidedAt: new Date(),
                        account: gateAccount,
                        signal: gateSignal,
                        position: gatePosition,
                        analyses: gateAnalyses,
                        modelId: gateConfig.modelId,
                        userApiKey: gateApiKey,
                    };

                    let entryDetail: ReturnType<typeof gateDetail> | undefined;

                    if (decision.action === 'buy' || decision.action === 'average_in') {
                        // Entries are fail-CLOSED: no fraction, no order. A missed buy is a
                        // missed opportunity, but committing the full budget on an unverified
                        // signal is real money at risk — the asymmetry is deliberate (§8).
                        let entryFraction = 1;
                        let entrySource: GateSource = 'disabled';
                        let entryOutcome: TradeGateOutcome | null = null;
                        if (gateConfig.enabled) {
                            if (Date.now() > gateDeadlineMs) {
                                await notifyError(
                                    `게이트 컷오프: ${item.symbol}`,
                                    `실행 시작 후 600초를 넘겨 진입 사이징 게이트를 호출하지 못해 매수를 건너뜁니다.`,
                                );
                                decisions.push({
                                    symbol: item.symbol,
                                    action: 'gate_skipped_deadline',
                                    score: decision.score,
                                    executed: false,
                                    reason: decision.reason,
                                    detail: {
                                        ...scoreDetail,
                                        ...gateDetail({
                                            kind: 'entry',
                                            source: 'deadline',
                                            model: gateConfig.modelId,
                                            fraction: 0,
                                            outcome: null,
                                            plan: maxPlan,
                                            quantity: 0,
                                        }),
                                    },
                                });
                                continue;
                            }
                            entryOutcome = await runTradeGate({
                                ...gateCommon,
                                kind: 'entry',
                                budget: {
                                    fullBudget: maxPlan.fullBudget,
                                    limitedBy: maxPlan.limitedBy,
                                    maxQuantity: maxPlan.quantity,
                                },
                                exit: null,
                                correlationId: `${cronRunId}-${item.symbol}-entry`,
                            });
                            if (entryOutcome.status === 'ok') {
                                entryFraction = entryOutcome.fraction;
                                entrySource = 'ai';
                            } else {
                                await notifyError(
                                    `진입 게이트 실패: ${item.symbol}`,
                                    `사이징 게이트 오류로 매수를 실행하지 않습니다 (fail-closed).\n오류: ${entryOutcome.error}`,
                                );
                                decisions.push({
                                    symbol: item.symbol,
                                    action: 'gate_error',
                                    score: decision.score,
                                    executed: false,
                                    reason: decision.reason,
                                    detail: {
                                        ...scoreDetail,
                                        ...gateDetail({
                                            kind: 'entry',
                                            source: 'error',
                                            model: gateConfig.modelId,
                                            fraction: 0,
                                            outcome: entryOutcome,
                                            plan: maxPlan,
                                            quantity: 0,
                                        }),
                                    },
                                });
                                continue;
                            }
                        }
                        const finalPlan =
                            entryFraction === 1
                                ? maxPlan
                                : planEntry({ ...entryPlanInputs, fraction: entryFraction });
                        entryDetail = gateDetail({
                            kind: 'entry',
                            source: entrySource,
                            model: gateConfig.modelId,
                            fraction: entryFraction,
                            outcome: entryOutcome,
                            plan: finalPlan,
                            quantity: finalPlan.quantity,
                        });
                        if (finalPlan.quantity === 0) {
                            // A deliberate "sit this tick out", not an error — no email.
                            decisions.push({
                                symbol: item.symbol,
                                action: 'entry_deferred',
                                score: decision.score,
                                executed: false,
                                reason: decision.reason,
                                detail: { ...scoreDetail, ...entryDetail },
                            });
                            continue;
                        }
                        decision = { ...decision, quantity: finalPlan.quantity };
                    } else if (decision.action === 'sell' && existingPosition) {
                        // Signal-driven sell — same fail-OPEN policy as the re-evaluation loop.
                        let sellFraction = 1;
                        let sellSource: GateSource = 'disabled';
                        let sellOutcome: TradeGateOutcome | null = null;
                        if (gateConfig.enabled && Date.now() > gateDeadlineMs) {
                            sellSource = 'deadline';
                        } else if (gateConfig.enabled) {
                            sellOutcome = await runTradeGate({
                                ...gateCommon,
                                kind: 'exit',
                                budget: null,
                                exit: { trigger: 'signal_sell', ruleReason: decision.reason },
                                correlationId: `${cronRunId}-${item.symbol}-exit`,
                            });
                            if (sellOutcome.status === 'ok') {
                                sellFraction = sellOutcome.fraction;
                                sellSource = 'ai';
                            } else {
                                sellSource = 'error';
                                await notifyError(
                                    `청산 게이트 실패: ${item.symbol}`,
                                    `사이징 게이트 오류로 전량 매도합니다 (fail-open).\n오류: ${sellOutcome.error}`,
                                );
                            }
                        }
                        const sellQty = planExit({
                            positionQuantity: existingPosition.quantity,
                            fraction: sellFraction,
                            trigger: 'signal_sell',
                        });
                        entryDetail = gateDetail({
                            kind: 'exit',
                            source: sellSource,
                            model: gateConfig.modelId,
                            fraction: sellFraction,
                            outcome: sellOutcome,
                            quantity: sellQty,
                        });
                        if (sellQty === 0) {
                            decisions.push({
                                symbol: item.symbol,
                                action: 'exit_deferred',
                                score: decision.score,
                                executed: false,
                                reason: decision.reason,
                                detail: { ...scoreDetail, ...entryDetail },
                            });
                            continue;
                        }
                        decision = { ...decision, quantity: sellQty };
                    }

                    // Execute based on mode (snapshot from run start)
                    let decisionPushed = false;
                    switch (tradingMode) {
                        case 'dry_run':
                            if (decision.action === 'buy' || decision.action === 'average_in') {
                                const dryRunSide = 'buy';
                                const existingDryRun = await getOpenPositionBySymbol(
                                    db,
                                    item.symbol,
                                );
                                await db.transaction(async (tx) => {
                                    await insertTrade(tx, {
                                        symbol: item.symbol,
                                        side: dryRunSide,
                                        orderType: 'market',
                                        quantity: decision.quantity,
                                        price: currentPrice,
                                        executedAt: new Date(),
                                        reason: decision.reason,
                                        mode: 'dry_run',
                                        cronRunId,
                                    });
                                    if (existingDryRun) {
                                        await averageIntoPosition(
                                            tx,
                                            existingDryRun.id,
                                            decision.quantity,
                                            currentPrice,
                                        );
                                    } else {
                                        await openPosition(tx, {
                                            symbol: item.symbol,
                                            side: 'long',
                                            quantity: decision.quantity,
                                            avgPrice: currentPrice,
                                        });
                                    }
                                });
                                // A1: notify on dry_run buy fills, mirroring the auto path.
                                await dispatcher
                                    .notifyTradeExecuted({
                                        symbol: item.symbol,
                                        side: 'buy',
                                        quantity: decision.quantity,
                                        price: currentPrice,
                                        reason: decision.reason,
                                        mode: 'dry_run',
                                    })
                                    .catch((err) => console.error('[email] send failed:', err));
                                currentExposure += currentPrice * decision.quantity;
                            } else if (decision.action === 'sell') {
                                const existingSellPos = await getOpenPositionBySymbol(
                                    db,
                                    item.symbol,
                                );
                                if (existingSellPos) {
                                    try {
                                        await db.transaction(async (tx) => {
                                            // A gate-sized signal sell can be partial — only a
                                            // full-size sell closes the position (mirrors the
                                            // auto path and the re-evaluation loop).
                                            if (decision.quantity >= existingSellPos.quantity) {
                                                const closed = await closePosition(
                                                    tx,
                                                    existingSellPos.id,
                                                    currentPrice,
                                                );
                                                if (!closed)
                                                    throw new Error('POSITION_ALREADY_CLOSED');
                                            } else {
                                                await reducePositionQuantity(
                                                    tx,
                                                    existingSellPos.id,
                                                    decision.quantity,
                                                );
                                            }
                                            await insertTrade(tx, {
                                                symbol: item.symbol,
                                                side: decision.action,
                                                orderType: 'market',
                                                quantity: decision.quantity,
                                                price: currentPrice,
                                                executedAt: new Date(),
                                                reason: decision.reason,
                                                mode: 'dry_run',
                                                cronRunId,
                                                realizedPnl: realizedPnlForSell(
                                                    currentPrice,
                                                    Number(existingSellPos.avgPrice),
                                                    decision.quantity,
                                                ),
                                            });
                                        });
                                        // A1: notify on dry_run sell fills.
                                        await dispatcher
                                            .notifyTradeExecuted({
                                                symbol: item.symbol,
                                                side: 'sell',
                                                quantity: decision.quantity,
                                                price: currentPrice,
                                                reason: decision.reason,
                                                mode: 'dry_run',
                                            })
                                            .catch((err) =>
                                                console.error('[email] send failed:', err),
                                            );
                                        currentExposure -= currentPrice * decision.quantity;
                                        if (currentExposure < 0) currentExposure = 0;
                                    } catch (txErr) {
                                        if (
                                            txErr instanceof Error &&
                                            txErr.message === 'POSITION_ALREADY_CLOSED'
                                        ) {
                                            decisions.push({
                                                symbol: item.symbol,
                                                action: 'already_closed',
                                                score: decision.score,
                                            });
                                            decisionPushed = true;
                                        } else {
                                            throw txErr;
                                        }
                                    }
                                } else {
                                    // Position disappeared between guard check and execution — skip
                                    decisions.push({
                                        symbol: item.symbol,
                                        action: 'no_position_to_sell',
                                        score: decision.score,
                                    });
                                    decisionPushed = true;
                                }
                            } else {
                                await insertTrade(db, {
                                    symbol: item.symbol,
                                    side: decision.action,
                                    orderType: 'market',
                                    quantity: decision.quantity,
                                    price: currentPrice,
                                    executedAt: new Date(),
                                    reason: decision.reason,
                                    mode: 'dry_run',
                                    cronRunId,
                                });
                            }
                            break;

                        case 'semi_auto': {
                            // Prevent duplicate pending orders for the same symbol
                            const existingPending = (await getPendingOrders(db)).find(
                                (o) => o.symbol === item.symbol && o.status === 'pending',
                            );
                            if (existingPending) {
                                decisions.push({
                                    symbol: item.symbol,
                                    action: 'pending_exists',
                                    score: decision.score,
                                });
                                decisionPushed = true;
                                break;
                            }
                            const pendingSide =
                                decision.action === 'average_in' ? 'buy' : decision.action;
                            await insertPendingOrder(db, {
                                symbol: item.symbol,
                                side: pendingSide,
                                quantity: decision.quantity,
                                priceLimit: currentPrice,
                                analysisSummary: decision.reason,
                                signalScore: decision.score,
                                expiresAt: new Date(Date.now() + 15 * 60 * 1000),
                            });
                            // Track pending order exposure to prevent over-allocation
                            if (decision.action === 'buy' || decision.action === 'average_in') {
                                currentExposure += currentPrice * decision.quantity;
                            }
                            await dispatcher
                                .notifyApprovalRequest({
                                    symbol: item.symbol,
                                    side: pendingSide,
                                    quantity: decision.quantity,
                                    score: decision.score,
                                    reason: decision.reason,
                                    approveUrl: 'https://auto-trade.siglens.io/pending',
                                })
                                .catch((err) => console.error('[email] send failed:', err));
                            // Pending order awaits human approval — NOT a fill.
                            decisions.push({
                                symbol: item.symbol,
                                action: decision.action,
                                score: decision.score,
                                executed: false,
                            });
                            decisionPushed = true;
                            break;
                        }

                        case 'auto': {
                            const autoSide =
                                decision.action === 'average_in' ? 'buy' : decision.action;
                            const isBuyOrder =
                                decision.action === 'buy' || decision.action === 'average_in';
                            let autoQuantity = decision.quantity;

                            // Buying-power guard (BUY/average_in): fail-closed when buying power is unknown.
                            // If the broker fetch failed (null), skip all buy orders — we cannot verify
                            // there is enough cash. Sells are unaffected (closing exposure is safe).
                            if (isBuyOrder && remainingBuyingPower === null) {
                                decisions.push({
                                    symbol: item.symbol,
                                    action: 'skipped_no_buying_power',
                                    score: decision.score,
                                    executed: false,
                                });
                                decisionPushed = true;
                                break;
                            }
                            // Buying-power guard (BUY/average_in): skip if cost exceeds remaining
                            // USD cash (running balance, decremented after each live buy this run).
                            if (
                                isBuyOrder &&
                                remainingBuyingPower != null &&
                                currentPrice * autoQuantity > remainingBuyingPower
                            ) {
                                decisions.push({
                                    symbol: item.symbol,
                                    action: 'skipped_insufficient_cash',
                                    score: decision.score,
                                });
                                decisionPushed = true;
                                break;
                            }

                            // Sellable-quantity guard (SELL): skip if none sellable, clamp if short.
                            if (decision.action === 'sell') {
                                const sellable = await getSellableQuantity(item.symbol).catch(
                                    () => null,
                                );
                                if (sellable != null) {
                                    // Clamp first, then reject — a fractional sellable (0<x<1)
                                    // floors to 0 and must not produce a 0-qty order.
                                    const clamped = Math.min(autoQuantity, Math.floor(sellable));
                                    if (clamped <= 0) {
                                        decisions.push({
                                            symbol: item.symbol,
                                            action: 'skipped_not_sellable',
                                            score: decision.score,
                                        });
                                        decisionPushed = true;
                                        break;
                                    }
                                    autoQuantity = clamped;
                                }
                            }

                            const idempotencyKey = `${cronRunId}-${item.symbol}-${autoSide}`;
                            const clientOrderId = crypto.randomUUID();
                            await createOrderTracking(db, {
                                idempotencyKey,
                                clientOrderId,
                                symbol: item.symbol,
                                side: autoSide,
                                quantity: autoQuantity,
                                status: 'submitted',
                                cronRunId,
                            });
                            const orderFn = isBuyOrder ? executeBuyOrder : executeSellOrder;
                            let orderResult;
                            try {
                                orderResult = await orderFn(
                                    item.symbol,
                                    autoQuantity,
                                    clientOrderId,
                                );
                            } catch (apiErr) {
                                await updateOrderTracking(db, idempotencyKey, {
                                    status: 'error',
                                    resolvedAt: new Date(),
                                }).catch(() => {});
                                throw apiErr;
                            }
                            // Early status write for non-filled outcomes only. For 'filled' the
                            // ONLY status write happens inside the booking tx (clean fill) or the
                            // needs_review write below — never here — so 'filled' can't exist
                            // without its trade.
                            if (orderResult.status !== 'filled') {
                                const autoResolved =
                                    orderResult.status !== 'pending' &&
                                    orderResult.status !== 'partial';
                                await updateOrderTracking(db, idempotencyKey, {
                                    tossOrderId: orderResult.orderId || undefined,
                                    status: orderResult.status,
                                    filledPrice: orderResult.avgFilledPrice ?? undefined,
                                    resolvedAt: autoResolved ? new Date() : undefined,
                                });
                            }
                            if (
                                orderResult.status === 'rejected' ||
                                orderResult.status === 'canceled'
                            ) {
                                decisions.push({
                                    symbol: item.symbol,
                                    action: 'order_rejected',
                                    score: decision.score,
                                });
                                decisionPushed = true;
                                await notifyError(
                                    `주문 거부: ${item.symbol}`,
                                    orderResult.rejectReason ?? '거부 사유 없음',
                                );
                                break;
                            }
                            // Order is live (filled/partial/pending) and will consume cash —
                            // optimistically decrement the running balance so subsequent buys
                            // this run see reduced cash.
                            // For a clean fill we use filledPrice (actual cost); for pending/partial
                            // we use the request price (filled qty unknown at this point).
                            if (isBuyOrder && remainingBuyingPower != null) {
                                const priceForDebit =
                                    orderResult &&
                                    orderResult.status === 'filled' &&
                                    orderResult.avgFilledPrice != null
                                        ? orderResult.avgFilledPrice
                                        : currentPrice;
                                const costActual = priceForDebit * autoQuantity;
                                const costIntended = currentPrice * autoQuantity;
                                if (
                                    orderResult &&
                                    orderResult.status === 'filled' &&
                                    costActual > costIntended * 1.01
                                ) {
                                    console.warn(
                                        '[execute] fill exceeded budget',
                                        item.symbol,
                                        `intended=$${costIntended.toFixed(2)}`,
                                        `actual=$${costActual.toFixed(2)}`,
                                    );
                                }
                                remainingBuyingPower -= costActual;
                            }
                            // pending/partial: NO trade, NO position mutation, NO exposure change.
                            // Reconcile owns final booking (single source of truth → no double-count).
                            // partial differs only in tracking status + notification text.
                            if (
                                orderResult.status === 'pending' ||
                                orderResult.status === 'partial'
                            ) {
                                if (orderResult.status === 'partial') {
                                    await notifyError(
                                        `부분 체결: ${item.symbol}`,
                                        `${item.symbol} ${orderResult.filledQuantity ?? '?'} / ${autoQuantity}주 부분 체결, 주문ID ${orderResult.orderId ?? 'N/A'}, reconcile가 잔량/최종 체결을 확정합니다.`,
                                    );
                                } else {
                                    await notifyError(
                                        `미체결 주문: ${item.symbol}`,
                                        `${item.symbol} ${decision.action} ${autoQuantity}주 주문이 접수되었으나 아직 체결되지 않았습니다. 주문 ID: ${orderResult.orderId ?? 'N/A'}`,
                                    );
                                }
                                decisions.push({
                                    symbol: item.symbol,
                                    action:
                                        orderResult.status === 'partial'
                                            ? 'order_partial'
                                            : 'order_submitted',
                                    score: decision.score,
                                });
                                decisionPushed = true;
                                break;
                            }
                            // status === 'filled' — auto-book ONLY a clean full fill:
                            // broker filled qty == intended integer qty (within epsilon) AND a
                            // real fill price is present. Any other outcome (short/fractional
                            // fill or missing price) is routed to needs_review (no auto-book).
                            const filledQ = orderResult.filledQuantity ?? autoQuantity;
                            const cleanFullFill =
                                orderResult.avgFilledPrice != null &&
                                Number.isInteger(autoQuantity) &&
                                Math.abs(filledQ - autoQuantity) < 1e-6;
                            if (!cleanFullFill) {
                                // 단축/소수점 체결 또는 체결가 누락 → 자동 기록하지 않고 수동 검토로
                                await updateOrderTracking(db, idempotencyKey, {
                                    status: 'needs_review',
                                    filledPrice: orderResult.avgFilledPrice ?? undefined,
                                    resolvedAt: new Date(),
                                });
                                await notifyError(
                                    `체결 수동확인 필요: ${item.symbol}`,
                                    `${autoSide} 주문이 예상과 다르게 체결됨 (의도 ${autoQuantity}주, 체결 ${filledQ}, 체결가 ${orderResult.avgFilledPrice ?? '없음'}). 수동 기록 필요.`,
                                ).catch((e) => console.error('[email]', e));
                                decisions.push({
                                    symbol: item.symbol,
                                    action: 'needs_review',
                                    score: decision.score,
                                });
                                decisionPushed = true;
                                break;
                            }
                            const filledPrice = orderResult.avgFilledPrice!;
                            const actualQuantity = autoQuantity; // integer, == filledQ
                            const tradeReason = decision.reason;
                            if (decision.action === 'buy' || decision.action === 'average_in') {
                                const existingAuto = await getOpenPositionBySymbol(db, item.symbol);
                                await db.transaction(async (tx) => {
                                    await insertTrade(tx, {
                                        symbol: item.symbol,
                                        side: autoSide,
                                        orderType: 'market',
                                        quantity: actualQuantity,
                                        price: filledPrice,
                                        executedAt: new Date(),
                                        reason: tradeReason,
                                        mode: 'auto',
                                        cronRunId,
                                        clientOrderId,
                                    });
                                    if (existingAuto) {
                                        await averageIntoPosition(
                                            tx,
                                            existingAuto.id,
                                            actualQuantity,
                                            filledPrice,
                                        );
                                    } else {
                                        await openPosition(tx, {
                                            symbol: item.symbol,
                                            side: 'long',
                                            quantity: actualQuantity,
                                            avgPrice: filledPrice,
                                        });
                                    }
                                    // ATOMIC: mark filled inside the same tx so 'filled' never
                                    // exists without its trade (double-book race guard).
                                    await updateOrderTracking(tx, idempotencyKey, {
                                        tossOrderId: orderResult.orderId || undefined,
                                        status: 'filled',
                                        filledPrice,
                                        resolvedAt: new Date(),
                                    });
                                });
                                currentExposure += filledPrice * actualQuantity;
                            } else if (decision.action === 'sell') {
                                const existingSellPos = await getOpenPositionBySymbol(
                                    db,
                                    item.symbol,
                                );
                                if (existingSellPos) {
                                    try {
                                        await db.transaction(async (tx) => {
                                            if (actualQuantity >= existingSellPos.quantity) {
                                                const closed = await closePosition(
                                                    tx,
                                                    existingSellPos.id,
                                                    filledPrice,
                                                );
                                                if (!closed)
                                                    throw new Error('POSITION_ALREADY_CLOSED');
                                            } else {
                                                await reducePositionQuantity(
                                                    tx,
                                                    existingSellPos.id,
                                                    actualQuantity,
                                                );
                                            }
                                            await insertTrade(tx, {
                                                symbol: item.symbol,
                                                side: autoSide,
                                                orderType: 'market',
                                                quantity: actualQuantity,
                                                price: filledPrice,
                                                executedAt: new Date(),
                                                reason: tradeReason,
                                                mode: 'auto',
                                                cronRunId,
                                                clientOrderId,
                                                realizedPnl: realizedPnlForSell(
                                                    filledPrice,
                                                    Number(existingSellPos.avgPrice),
                                                    actualQuantity,
                                                ),
                                            });
                                            // ATOMIC: mark filled inside the same tx.
                                            await updateOrderTracking(tx, idempotencyKey, {
                                                tossOrderId: orderResult.orderId || undefined,
                                                status: 'filled',
                                                filledPrice,
                                                resolvedAt: new Date(),
                                            });
                                        });
                                        currentExposure -= filledPrice * actualQuantity;
                                        if (currentExposure < 0) currentExposure = 0;
                                    } catch (txErr) {
                                        if (
                                            txErr instanceof Error &&
                                            txErr.message === 'POSITION_ALREADY_CLOSED'
                                        ) {
                                            decisions.push({
                                                symbol: item.symbol,
                                                action: 'already_closed',
                                                score: decision.score,
                                            });
                                            decisionPushed = true;
                                            break;
                                        }
                                        throw txErr;
                                    }
                                } else {
                                    // Position disappeared between guard check and fill — record trade + alert
                                    await db.transaction(async (tx) => {
                                        await insertTrade(tx, {
                                            symbol: item.symbol,
                                            side: 'sell',
                                            orderType: 'market',
                                            quantity: actualQuantity,
                                            price: filledPrice,
                                            executedAt: new Date(),
                                            reason: `${tradeReason} (포지션 미확인 — 수동 확인 필요)`,
                                            mode: 'auto',
                                            cronRunId,
                                            clientOrderId,
                                        });
                                        // ATOMIC: mark filled inside the same tx.
                                        await updateOrderTracking(tx, idempotencyKey, {
                                            tossOrderId: orderResult.orderId || undefined,
                                            status: 'filled',
                                            filledPrice,
                                            resolvedAt: new Date(),
                                        });
                                    });
                                    await notifyError(
                                        `포지션 미확인 매도 체결: ${item.symbol}`,
                                        `${item.symbol} ${actualQuantity}주가 체결되었으나 DB에 포지션이 없습니다.`,
                                    ).catch((e) => console.error('[email]', e));
                                }
                            } else {
                                await db.transaction(async (tx) => {
                                    await insertTrade(tx, {
                                        symbol: item.symbol,
                                        side: autoSide,
                                        orderType: 'market',
                                        quantity: actualQuantity,
                                        price: filledPrice,
                                        executedAt: new Date(),
                                        reason: tradeReason,
                                        mode: 'auto',
                                        cronRunId,
                                        clientOrderId,
                                    });
                                    // ATOMIC: mark filled inside the same tx.
                                    await updateOrderTracking(tx, idempotencyKey, {
                                        tossOrderId: orderResult.orderId || undefined,
                                        status: 'filled',
                                        filledPrice,
                                        resolvedAt: new Date(),
                                    });
                                });
                            }
                            await dispatcher
                                .notifyTradeExecuted({
                                    symbol: item.symbol,
                                    side: autoSide,
                                    quantity: actualQuantity,
                                    price: filledPrice,
                                    reason: tradeReason,
                                    mode: 'auto',
                                })
                                .catch((err) => console.error('[email] send failed:', err));
                            break;
                        }
                    }

                    if (!decisionPushed) {
                        decisions.push({
                            symbol: item.symbol,
                            action: decision.action,
                            score: decision.score,
                            executed: true,
                            reason: decision.reason,
                            detail: { ...scoreDetail, ...(entryDetail ?? {}) },
                        });
                    }
                } catch (err) {
                    await notifyError(item.symbol, String(err));
                    decisions.push({ symbol: item.symbol, action: 'error', score: 0 });
                }
            }

            const decisionsByAction = decisions.reduce<Record<string, number>>((acc, d) => {
                acc[d.action] = (acc[d.action] ?? 0) + 1;
                return acc;
            }, {});
            finishState = {
                status: 'completed',
                outcome: 'completed',
                summary: {
                    symbolsEvaluated: decisions.length,
                    decisionsByAction,
                    pendingBuyExposure,
                    pendingBuyExposureMissingPrice,
                },
                ...elapsed(),
            };
            return Response.json({
                cronRunId,
                tradingMode,
                decisions: decisions.map(publicDecision),
            });
        } finally {
            await releaseLock(LOCK_KEY, lockToken).catch((e) => console.error('[lock-release]', e));
        }
    } catch (e) {
        finishState = {
            status: 'error',
            error: e instanceof Error ? e.message : String(e),
            ...elapsed(),
        };
        throw e;
    } finally {
        if (finishState) {
            await safe(finishCronRun(db, cronRunId, finishState));
            await safe(
                insertCronDecisions(
                    db,
                    cronRunId,
                    'execute',
                    decisions.map((d) => ({
                        symbol: d.symbol,
                        action: d.action,
                        score: d.score,
                        executed: d.executed ?? false,
                        reason: d.reason,
                        detail: d.detail,
                    })),
                ),
            );
        }
    }
}

// Vercel Node runtime: expose Web `Request`/`Response` handlers via named HTTP-method
// exports. A bare `export default` would be treated as the legacy `(req, res)` handler.
export const GET = handler;
