import { verifyCronSecret } from '../_lib/cron-auth.js';
import { getDb } from '../_lib/db.js';
import {
    getEnabledWatchlist,
    getConfigValue,
    getAnalysisConfig,
    getLatestAnalysisResult,
    getOpenPositions,
    getOpenPositionBySymbol,
    openPosition,
    closePosition,
    reducePositionQuantity,
    saveAnalysisResult,
    insertTrade,
    insertPendingOrder,
    getPendingOrders,
    getTodayTradeCount,
    getTodayRealizedPnl,
    expireOldPendingOrders,
    createOrderTracking,
    updateOrderTracking,
    getPendingSubmittedOrders,
    averageIntoPosition,
    getNotificationConfig,
    startCronRun,
    finishCronRun,
    insertCronDecisions,
} from '../../lib/db/queries.js';
import type { CronRunFinish } from '../../lib/db/queries.js';
import { runOverallAnalysis } from '../../lib/analysis/run-overall.js';
import { scoreSignals } from '../../lib/strategy/signal-scorer.js';
import {
    calculatePositionSize,
    evaluateExistingPosition,
} from '../../lib/strategy/risk-manager.js';
import { makeTradeDecision } from '../../lib/strategy/decision.js';
import { executeBuyOrder, executeSellOrder } from '../../lib/trading/orders.js';
import { getBuyingPower, getSellableQuantity, isUsMarketOpen } from '../../lib/trading/account.js';
import {
    sendTradeExecutedEmail,
    sendApprovalRequestEmail,
    sendErrorEmail,
} from '../../lib/notification/email.js';
import { makeEmailGate } from '../../lib/notification/gate.js';
import {
    DEFAULT_WEIGHTS,
    DEFAULT_BUY_THRESHOLD,
    DEFAULT_SELL_THRESHOLD,
} from '../../lib/strategy/types.js';
import type { ScoreWeights } from '../../lib/strategy/types.js';
import { resolveApiKey } from './_run-analysis-cron.js';
import { acquireLock, releaseLock } from '../../lib/lock.js';
import { isEtRegularSessionOpen } from '@y0ngha/siglens-core';
import { fetchLivePrice } from '../../lib/data/live-price.js';
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
} from '../../lib/strategy/safe-extract.js';
import { realizedPnlForSell } from '../../lib/strategy/pnl.js';

/** Maximum age for analysis results before they are considered stale (4 hours). */
const MAX_ANALYSIS_AGE_MS = 4 * 60 * 60 * 1000;

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

    await safe(startCronRun(db, { runId: cronRunId, cronType: 'execute', startedAt }));

    let finishState: CronRunFinish | null = null;
    const decisions: Array<{ symbol: string; action: string; score: number; executed?: boolean }> =
        [];

    try {
        // Skip trade execution outside the U.S. regular session (cron schedule is a static approximation)
        if (!isEtRegularSessionOpen(new Date())) {
            finishState = { status: 'skipped', outcome: 'market_closed', ...elapsed() };
            return Response.json({ skipped: true, reason: 'market_closed' });
        }

        const LOCK_KEY = 'cron:execute:lock';
        let lockAcquired = false;
        // TTL < maxDuration(800s): a hung run holds the lock for its whole life (no mid-run expiry/overlap), and a killed fn's lock can't outlive it.
        const locked = await acquireLock(LOCK_KEY, 780);
        if (!locked) {
            finishState = { status: 'skipped', outcome: 'locked', ...elapsed() };
            return Response.json({ skipped: true, reason: 'another_execution_in_progress' });
        }
        lockAcquired = true;

        try {
            // Email notification gate — respect the dashboard ON/OFF toggle + per-event
            // selection. Legacy 'approval_required' is honored as an alias for 'order_pending'.
            // Defined early so circuit-breaker alerts below also go through the gate.
            const emailNotif = (await getNotificationConfig(db)).find((n) => n.channel === 'email');
            const shouldEmail = makeEmailGate(emailNotif);
            // Error/safety alerts are gated on the 'error' (시스템 오류) event — same contract
            // as reconcile's notifyError, so "email OFF" suppresses every email uniformly.
            const notifyError = (subject: string, body: string) =>
                shouldEmail('error')
                    ? sendErrorEmail(subject, body).catch((e) => console.error('[email]', e))
                    : Promise.resolve();

            // Circuit breaker: kill switch
            const tradingEnabled = (await getConfigValue<boolean>(db, 'trading_enabled')) ?? true;
            if (!tradingEnabled) {
                finishState = { status: 'skipped', outcome: 'trading_disabled', ...elapsed() };
                return Response.json({ skipped: true, reason: 'trading_disabled' });
            }

            // Clean up expired pending orders
            await expireOldPendingOrders(db);

            // Circuit breaker: daily trade limit
            const maxTradesPerDay = (await getConfigValue<number>(db, 'max_trades_per_day')) ?? 20;
            const todayTradeCount = await getTodayTradeCount(db);
            if (todayTradeCount >= maxTradesPerDay) {
                finishState = { status: 'skipped', outcome: 'daily_trade_limit', ...elapsed() };
                return Response.json({
                    skipped: true,
                    reason: 'daily_trade_limit_reached',
                    todayCount: todayTradeCount,
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
                            unrealizedPnl += (curPrice - avgP) * pos.quantity;
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
            const weights =
                (await getConfigValue<ScoreWeights>(db, 'score_weights')) ?? DEFAULT_WEIGHTS;
            const buyThreshold =
                (await getConfigValue<number>(db, 'buy_threshold')) ?? DEFAULT_BUY_THRESHOLD;
            const sellThreshold =
                (await getConfigValue<number>(db, 'sell_threshold')) ?? DEFAULT_SELL_THRESHOLD;

            const stopLossPercent = (await getConfigValue<number>(db, 'stop_loss_percent')) ?? 5;
            const takeProfitPercent =
                (await getConfigValue<number>(db, 'take_profit_percent')) ?? 10;
            const fixedExitEnabled =
                (await getConfigValue<boolean>(db, 'fixed_exit_enabled')) ?? false;

            // U.S. market-holiday gating (non-dry-run only). isEtRegularSessionOpen already
            // gated by wall-clock at entry; this catches holidays the static schedule misses.
            if (tradingMode !== 'dry_run') {
                const marketOpen = await isUsMarketOpen().catch(() => true); // 조회 실패 시 기존 시간기반 동작 유지
                if (!marketOpen) {
                    finishState = {
                        status: 'skipped',
                        outcome: 'us_market_holiday',
                        ...elapsed(),
                    };
                    return Response.json({ skipped: true, reason: 'us-market-holiday' });
                }
            }

            const watchlistItems = await getEnabledWatchlist(db);

            // Calculate current exposure using current market prices when available,
            // falling back to avgPrice when no analysis data exists.
            const openPositions = await getOpenPositions(db);

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

            const overallConfig = await getAnalysisConfig(db, 'overall');

            // Track symbols closed by stop-loss in this cron run to prevent immediate re-buy
            const recentStopLossSymbols = new Set<string>();

            // --- Price cache: batch fetch all needed symbols once ---
            const priceCache = new Map<string, number>();
            const allSymbols = new Set<string>();
            for (const p of openPositions) allSymbols.add(p.symbol);
            for (const w of watchlistItems) allSymbols.add(w.symbol);
            for (const sym of allSymbols) {
                const price = await fetchLivePrice(sym).catch(() => null);
                if (price) priceCache.set(sym, price);
            }

            // USD buying power, fetched once per invocation (auto mode only — guard not used in semi_auto).
            // null => guard disabled (fetch failed or non-auto mode) — fall back to prior behavior.
            const usdBuyingPower =
                tradingMode === 'auto' ? await getBuyingPower('USD').catch(() => null) : null;
            // Running balance: optimistically decremented after each live buy so multiple
            // buys in one run don't all authorize against the same un-decremented cash.
            // null => guard disabled. Reconcile/next-run corrects against broker reality.
            let remainingBuyingPower: number | null = usdBuyingPower;

            // Fetch pending submitted orders once for sell-guard checks
            const pendingSubmittedOrders = await getPendingSubmittedOrders(db);

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

                    const [tech, news, overallResult] = await Promise.all([
                        getLatestAnalysisResult(db, position.symbol, 'technical'),
                        getLatestAnalysisResult(db, position.symbol, 'news'),
                        getLatestAnalysisResult(db, position.symbol, 'overall'),
                    ]);

                    // Staleness check: skip position if technical analysis is too old
                    const techAge = tech
                        ? Date.now() - new Date(tech.analyzedAt).getTime()
                        : Infinity;
                    if (techAge > MAX_ANALYSIS_AGE_MS) {
                        decisions.push({
                            symbol: position.symbol,
                            action: 'stale_analysis',
                            score: 0,
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
                        });
                        await notifyError(
                            `가격 데이터 없음: ${position.symbol}`,
                            `${position.symbol} 포지션의 현재 가격을 확인할 수 없어 평가를 건너뛰었습니다. 수동 확인이 필요합니다.`,
                        );
                        continue;
                    }

                    const overallSentiment = overallResult?.result
                        ? safeString(safeRecord(overallResult.result)?.integratedConclusionKo)
                        : undefined;

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
                        overallSignal: overallSentiment,
                    });

                    if (evaluation.action === 'hold') {
                        decisions.push({
                            symbol: position.symbol,
                            action: 'hold',
                            score: 0,
                            executed: false,
                        });
                        continue;
                    }

                    // Track stop-loss closures to prevent same-run re-buy
                    if (evaluation.action === 'stop_loss') {
                        recentStopLossSymbols.add(position.symbol);
                    }

                    // Execute the exit
                    let decisionPushed = false;
                    switch (tradingMode) {
                        case 'dry_run':
                            try {
                                await db.transaction(async (tx) => {
                                    const closed = await closePosition(
                                        tx,
                                        position.id,
                                        currentPrice,
                                    );
                                    if (!closed) throw new Error('POSITION_ALREADY_CLOSED');
                                    await insertTrade(tx, {
                                        symbol: position.symbol,
                                        side: 'sell',
                                        orderType: 'market',
                                        quantity: position.quantity,
                                        price: currentPrice,
                                        executedAt: new Date(),
                                        reason: evaluation.reason,
                                        mode: 'dry_run',
                                        cronRunId,
                                        realizedPnl: realizedPnlForSell(
                                            currentPrice,
                                            Number(position.avgPrice),
                                            position.quantity,
                                        ),
                                    });
                                });
                                currentExposure -= currentPrice * position.quantity;
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
                                quantity: position.quantity,
                                priceLimit: currentPrice,
                                analysisSummary: evaluation.reason,
                                signalScore: 0,
                                expiresAt: new Date(Date.now() + 15 * 60 * 1000),
                            });
                            if (shouldEmail('order_pending', 'approval_required')) {
                                await sendApprovalRequestEmail({
                                    symbol: position.symbol,
                                    side: 'sell',
                                    quantity: position.quantity,
                                    score: 0,
                                    reason: evaluation.reason,
                                    approveUrl: 'https://auto-trade.siglens.io/pending',
                                }).catch((err) => console.error('[email] send failed:', err));
                            }
                            // Pending order awaits human approval — NOT a fill.
                            decisions.push({
                                symbol: position.symbol,
                                action: evaluation.action,
                                score: 0,
                                executed: false,
                            });
                            decisionPushed = true;
                            break;

                        case 'auto': {
                            // Sellable-quantity guard: confirm broker holds enough shares.
                            let sellQty = position.quantity;
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
                            const exitEvent =
                                evaluation.action === 'stop_loss' ? 'stop_loss' : 'trade_executed';
                            if (shouldEmail(exitEvent)) {
                                await sendTradeExecutedEmail({
                                    symbol: position.symbol,
                                    side: 'sell',
                                    quantity: actualExitQty,
                                    price: filledSellPrice,
                                    reason: evaluation.reason,
                                    mode: 'auto',
                                }).catch((err) => console.error('[email] send failed:', err));
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

            for (const item of watchlistItems) {
                try {
                    // Gather latest analysis results
                    const [tech, news, options, fundamental] = await Promise.all([
                        getLatestAnalysisResult(db, item.symbol, 'technical'),
                        getLatestAnalysisResult(db, item.symbol, 'news'),
                        getLatestAnalysisResult(db, item.symbol, 'options'),
                        getLatestAnalysisResult(db, item.symbol, 'fundamental'),
                    ]);

                    // Staleness check: skip symbol if technical analysis is too old
                    const techAge = tech
                        ? Date.now() - new Date(tech.analyzedAt).getTime()
                        : Infinity;
                    if (techAge > MAX_ANALYSIS_AGE_MS) {
                        decisions.push({ symbol: item.symbol, action: 'stale_analysis', score: 0 });
                        continue;
                    }

                    // Optional: run overall analysis (skip if recent cache exists)
                    let overall = null;
                    if (overallConfig?.enabled) {
                        const existingOverall = await getLatestAnalysisResult(
                            db,
                            item.symbol,
                            'overall',
                        );
                        const TWO_HOURS = 2 * 60 * 60 * 1000;
                        const overallAge = existingOverall
                            ? Date.now() - new Date(existingOverall.analyzedAt).getTime()
                            : Infinity;

                        if (overallAge <= TWO_HOURS) {
                            overall = existingOverall!.result;
                        } else {
                            const overallResult = await runOverallAnalysis({
                                symbol: item.symbol,
                                companyName: item.companyName,
                                modelId: overallConfig.modelId as any,
                                userApiKey: overallConfig.useByok
                                    ? resolveApiKey(overallConfig.modelId)
                                    : undefined,
                            });
                            if (
                                overallResult.status === 'done' ||
                                overallResult.status === 'cached'
                            ) {
                                overall = overallResult.result;
                                await saveAnalysisResult(db, {
                                    symbol: item.symbol,
                                    analysisType: 'overall',
                                    result: overall,
                                    modelId: overallConfig.modelId,
                                    analyzedAt: new Date(),
                                    cronRunId,
                                });
                            }
                        }
                    }

                    // Score signals — build type-safe inputs from untyped AI results
                    const signalInputs = {
                        technical: tech?.result
                            ? {
                                  trend: safeAnalysisTrend(tech.result),
                                  riskLevel: safeString(safeRecord(tech.result)?.riskLevel),
                                  actionRecommendation: safeActionRecommendation(tech.result),
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
                                      | Array<{ type?: string }>
                                      | undefined,
                              }
                            : null,
                        fundamental: fundamental?.result
                            ? {
                                  overallSentiment: safeAnalysisSentiment(fundamental.result),
                              }
                            : null,
                        overall: overall
                            ? {
                                  integratedConclusionKo: safeString(
                                      safeRecord(overall)?.integratedConclusionKo,
                                  ),
                                  scenarios: safeArray(overall, 'scenarios'),
                              }
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
                        });
                        continue;
                    }

                    const calculatedSize = calculatePositionSize({
                        price: currentPrice,
                        maxPositionSize,
                        maxTotalExposure,
                        currentExposure,
                    });

                    // Circuit breaker: re-check daily trade limit before each trade
                    const currentDayCount = await getTodayTradeCount(db);
                    if (currentDayCount >= maxTradesPerDay) {
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
                        calculatedSize,
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

                    // Per-symbol exposure cap for average_in
                    if (decision.action === 'average_in' && existingPosition) {
                        const existingExposure = currentPrice * existingPosition.quantity;
                        const remainingSymbolBudget = Math.max(
                            0,
                            maxPositionSize - existingExposure,
                        );
                        const cappedSize = Math.floor(remainingSymbolBudget / currentPrice);
                        if (cappedSize <= 0) {
                            decisions.push({
                                symbol: item.symbol,
                                action: 'symbol_limit_reached',
                                score: decision.score,
                            });
                            continue;
                        }
                        decision = { ...decision, quantity: cappedSize };
                    }

                    // Insufficient balance — signal is buy but position size is 0
                    if (
                        decision.action === 'hold' &&
                        signalScore.signal === 'buy' &&
                        calculatedSize === 0
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
                                currentExposure += currentPrice * decision.quantity;
                            } else if (decision.action === 'sell') {
                                const existingSellPos = await getOpenPositionBySymbol(
                                    db,
                                    item.symbol,
                                );
                                if (existingSellPos) {
                                    try {
                                        await db.transaction(async (tx) => {
                                            const closed = await closePosition(
                                                tx,
                                                existingSellPos.id,
                                                currentPrice,
                                            );
                                            if (!closed) throw new Error('POSITION_ALREADY_CLOSED');
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
                            if (shouldEmail('order_pending', 'approval_required')) {
                                await sendApprovalRequestEmail({
                                    symbol: item.symbol,
                                    side: pendingSide,
                                    quantity: decision.quantity,
                                    score: decision.score,
                                    reason: decision.reason,
                                    approveUrl: 'https://auto-trade.siglens.io/pending',
                                }).catch((err) => console.error('[email] send failed:', err));
                            }
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
                            // this run see reduced cash. Uses request qty (filled qty unknown for pending).
                            if (isBuyOrder && remainingBuyingPower != null) {
                                remainingBuyingPower -= currentPrice * autoQuantity;
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
                            if (shouldEmail('trade_executed')) {
                                await sendTradeExecutedEmail({
                                    symbol: item.symbol,
                                    side: autoSide,
                                    quantity: actualQuantity,
                                    price: filledPrice,
                                    reason: tradeReason,
                                    mode: 'auto',
                                }).catch((err) => console.error('[email] send failed:', err));
                            }
                            break;
                        }
                    }

                    if (!decisionPushed) {
                        decisions.push({
                            symbol: item.symbol,
                            action: decision.action,
                            score: decision.score,
                            executed: true,
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
                },
                ...elapsed(),
            };
            return Response.json({ cronRunId, tradingMode, decisions });
        } finally {
            if (lockAcquired)
                await releaseLock(LOCK_KEY).catch((e) => console.error('[lock-release]', e));
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
                    })),
                ),
            );
        }
    }
}

// Vercel Node runtime: expose Web `Request`/`Response` handlers via named HTTP-method
// exports. A bare `export default` would be treated as the legacy `(req, res)` handler.
export const GET = handler;
