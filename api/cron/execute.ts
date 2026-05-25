import { verifyCronSecret } from '../_lib/cron-auth';
import { getDb } from '../_lib/db';
import {
    getEnabledWatchlist,
    getConfigValue,
    getAnalysisConfig,
    getLatestAnalysisResult,
    getOpenPositions,
    getOpenPositionBySymbol,
    openPosition,
    closePosition,
    saveAnalysisResult,
    insertTrade,
    insertPendingOrder,
    getPendingOrders,
    getTodayTradeCount,
    getTodayRealizedPnl,
    expireOldPendingOrders,
    createOrderTracking,
    updateOrderTracking,
} from '../../lib/db/queries';
import { runOverallAnalysis } from '../../lib/analysis/run-overall';
import { scoreSignals } from '../../lib/strategy/signal-scorer';
import { calculatePositionSize, evaluateExistingPosition } from '../../lib/strategy/risk-manager';
import { makeTradeDecision } from '../../lib/strategy/decision';
import { executeBuyOrder, executeSellOrder } from '../../lib/trading/order';
import {
    sendTradeExecutedEmail,
    sendApprovalRequestEmail,
    sendErrorEmail,
} from '../../lib/notification/email';
import {
    DEFAULT_WEIGHTS,
    DEFAULT_BUY_THRESHOLD,
    DEFAULT_SELL_THRESHOLD,
} from '../../lib/strategy/types';
import type { ScoreWeights } from '../../lib/strategy/types';
import { resolveApiKey } from './_run-analysis-cron';
import { acquireLock, releaseLock } from '../../lib/lock';
import { isFinitePositive, safeNumber } from '../../lib/validation';

/** Maximum age for analysis results before they are considered stale (4 hours). */
const MAX_ANALYSIS_AGE_MS = 4 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Safe extraction helpers for untyped AI analysis results
// ---------------------------------------------------------------------------

function safeRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return null;
}

function safeAnalysisPrice(result: unknown): number {
    const r = safeRecord(result);
    if (!r) return 0;
    const keyLevels = safeRecord(r.keyLevels);
    if (!keyLevels) return 0;
    const price = keyLevels.currentPrice;
    return isFinitePositive(price) ? price : 0;
}

function safeString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function safeAnalysisTrend(result: unknown): string | undefined {
    const r = safeRecord(result);
    return r ? safeString(r.trend) : undefined;
}

function safeAnalysisSentiment(result: unknown): string | undefined {
    const r = safeRecord(result);
    return r ? safeString(r.overallSentiment) : undefined;
}

function safeNumberArray(value: unknown): number[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const nums = value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return nums.length > 0 ? nums : undefined;
}

function safeAnalysisSupport(result: unknown): number | undefined {
    const r = safeRecord(result);
    if (!r) return undefined;
    const keyLevels = safeRecord(r.keyLevels);
    if (!keyLevels) return undefined;
    const levels = safeNumberArray(keyLevels.support);
    return levels?.[0];
}

function safeAnalysisResistance(result: unknown): number | undefined {
    const r = safeRecord(result);
    if (!r) return undefined;
    const keyLevels = safeRecord(r.keyLevels);
    if (!keyLevels) return undefined;
    const levels = safeNumberArray(keyLevels.resistance);
    return levels?.[0];
}

function safeAnalysisTargetPrice(result: unknown): number | undefined {
    const r = safeRecord(result);
    if (!r) return undefined;
    const priceTargets = safeRecord(r.priceTargets);
    if (!priceTargets) return undefined;
    const bullish = safeRecord(priceTargets.bullish);
    if (!bullish) return undefined;
    const target = bullish.target;
    return isFinitePositive(target) ? target : undefined;
}

function safeArray(obj: unknown, key: string): unknown[] | undefined {
    const r = safeRecord(obj);
    if (!r) return undefined;
    const val = r[key];
    return Array.isArray(val) ? val : undefined;
}

function safeActionRecommendation(
    obj: unknown,
): { action: 'buy' | 'hold' | 'wait'; confidence: number } | undefined {
    const r = safeRecord(obj);
    if (!r) return undefined;
    const rec = safeRecord(r.actionRecommendation);
    if (!rec) return undefined;
    const action = safeString(rec.action);
    if (action !== 'buy' && action !== 'hold' && action !== 'wait') return undefined;
    const confidence =
        typeof rec.confidence === 'number' && Number.isFinite(rec.confidence) ? rec.confidence : 0;
    return { action, confidence };
}

export default async function handler(req: Request): Promise<Response> {
    if (!verifyCronSecret(req)) {
        return new Response('Unauthorized', { status: 401 });
    }

    const LOCK_KEY = 'cron:execute:lock';
    const locked = await acquireLock(LOCK_KEY);
    if (!locked) {
        return Response.json({ skipped: true, reason: 'another_execution_in_progress' });
    }

    try {
        const db = getDb();

        // Circuit breaker: kill switch
        const tradingEnabled = (await getConfigValue<boolean>(db, 'trading_enabled')) ?? true;
        if (!tradingEnabled) {
            return Response.json({ skipped: true, reason: 'trading_disabled' });
        }

        // Clean up expired pending orders
        await expireOldPendingOrders(db);

        // Circuit breaker: daily trade limit
        const maxTradesPerDay = (await getConfigValue<number>(db, 'max_trades_per_day')) ?? 20;
        const todayTradeCount = await getTodayTradeCount(db);
        if (todayTradeCount >= maxTradesPerDay) {
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
            await sendErrorEmail(
                '일일 손실 한도 초과',
                `오늘 실현 손실($${Math.abs(todayPnl).toFixed(2)})이 한도($${maxDailyLoss})를 초과하여 매매가 중지되었습니다.`,
            ).catch((err) => console.error('[email] send failed:', err));
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
                    const techForPos = await getLatestAnalysisResult(db, pos.symbol, 'technical');
                    const curPrice = safeAnalysisPrice(techForPos?.result);
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
                await sendErrorEmail(
                    '일일 손실 한도 초과 (미실현 포함)',
                    `오늘 실현 손실($${Math.abs(todayPnl).toFixed(2)}) + 미실현 손실($${Math.abs(unrealizedPnl).toFixed(2)}) = 총 $${Math.abs(totalPnl).toFixed(2)}이 한도($${maxDailyLoss})를 초과하여 매매가 중지되었습니다.`,
                ).catch((err) => console.error('[email] send failed:', err));
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
        const maxTotalExposure = (await getConfigValue<number>(db, 'max_total_exposure')) ?? 5000;
        const weights =
            (await getConfigValue<ScoreWeights>(db, 'score_weights')) ?? DEFAULT_WEIGHTS;
        const buyThreshold =
            (await getConfigValue<number>(db, 'buy_threshold')) ?? DEFAULT_BUY_THRESHOLD;
        const sellThreshold =
            (await getConfigValue<number>(db, 'sell_threshold')) ?? DEFAULT_SELL_THRESHOLD;

        const stopLossPercent = (await getConfigValue<number>(db, 'stop_loss_percent')) ?? 5;
        const takeProfitPercent = (await getConfigValue<number>(db, 'take_profit_percent')) ?? 10;
        const fixedExitEnabled = (await getConfigValue<boolean>(db, 'fixed_exit_enabled')) ?? false;

        const watchlistItems = await getEnabledWatchlist(db);

        // Calculate current exposure using current market prices when available,
        // falling back to avgPrice when no analysis data exists.
        const openPositions = await getOpenPositions(db);

        if (watchlistItems.length === 0 && openPositions.length === 0) {
            return Response.json({ skipped: true, reason: 'empty_watchlist' });
        }

        let currentExposure = 0;
        for (const p of openPositions) {
            let priceForExposure = safeNumber(Number(p.avgPrice), 0);
            try {
                const techForExposure = await getLatestAnalysisResult(db, p.symbol, 'technical');
                const marketPrice = safeAnalysisPrice(techForExposure?.result);
                if (marketPrice > 0) priceForExposure = marketPrice;
            } catch {
                // Fall back to avgPrice when analysis data is unavailable
            }
            currentExposure += priceForExposure * p.quantity;
        }

        const cronRunId = `exec-${crypto.randomUUID()}`;
        const overallConfig = await getAnalysisConfig(db, 'overall');
        const decisions: Array<{ symbol: string; action: string; score: number }> = [];

        // Track symbols closed by stop-loss in this cron run to prevent immediate re-buy
        const recentStopLossSymbols = new Set<string>();

        // --- Position re-evaluation ---
        for (const position of openPositions) {
            try {
                const [tech, news, overallResult] = await Promise.all([
                    getLatestAnalysisResult(db, position.symbol, 'technical'),
                    getLatestAnalysisResult(db, position.symbol, 'news'),
                    getLatestAnalysisResult(db, position.symbol, 'overall'),
                ]);

                const techResult = tech?.result;
                const currentPrice = safeAnalysisPrice(techResult);
                if (currentPrice === 0) {
                    decisions.push({
                        symbol: position.symbol,
                        action: 'skipped_no_price',
                        score: 0,
                    });
                    await sendErrorEmail(
                        `가격 데이터 없음: ${position.symbol}`,
                        `${position.symbol} 포지션의 현재 가격을 확인할 수 없어 평가를 건너뛰었습니다. 수동 확인이 필요합니다.`,
                    ).catch((err) => console.error('[email] send failed:', err));
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

                if (evaluation.action === 'hold') continue;

                // Track stop-loss closures to prevent same-run re-buy
                if (evaluation.action === 'stop_loss') {
                    recentStopLossSymbols.add(position.symbol);
                }

                // Execute the exit
                let decisionPushed = false;
                switch (tradingMode) {
                    case 'dry_run':
                        await db.transaction(async (tx) => {
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
                            });
                            await closePosition(tx, position.id, currentPrice);
                        });
                        currentExposure -= currentPrice * position.quantity;
                        if (currentExposure < 0) currentExposure = 0;
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
                        await sendApprovalRequestEmail({
                            symbol: position.symbol,
                            side: 'sell',
                            quantity: position.quantity,
                            score: 0,
                            reason: evaluation.reason,
                            approveUrl: 'https://auto-trade.siglens.io/pending',
                        }).catch((err) => console.error('[email] send failed:', err));
                        break;

                    case 'auto': {
                        const exitIdempotencyKey = `${cronRunId}-${position.symbol}-sell`;
                        await createOrderTracking(db, {
                            idempotencyKey: exitIdempotencyKey,
                            symbol: position.symbol,
                            side: 'sell',
                            quantity: position.quantity,
                            status: 'submitted',
                            cronRunId,
                        });
                        const orderResult = await executeSellOrder(
                            position.symbol,
                            position.quantity,
                            exitIdempotencyKey,
                        );
                        await updateOrderTracking(db, exitIdempotencyKey, {
                            tossOrderId: orderResult.orderId,
                            status: orderResult.status,
                            filledPrice: orderResult.filledPrice ?? undefined,
                            resolvedAt: orderResult.status !== 'submitted' ? new Date() : undefined,
                        });
                        if (orderResult.status === 'rejected') {
                            decisions.push({
                                symbol: position.symbol,
                                action: 'order_rejected',
                                score: 0,
                            });
                            decisionPushed = true;
                            await sendErrorEmail(
                                `주문 거부: ${position.symbol}`,
                                orderResult.message ?? '거부 사유 없음',
                            ).catch((err) => console.error('[email] send failed:', err));
                            break;
                        }
                        if (orderResult.status === 'submitted') {
                            await sendErrorEmail(
                                `미체결 주문: ${position.symbol}`,
                                `${position.symbol} sell ${position.quantity}주 주문이 접수되었으나 아직 체결되지 않았습니다. 주문 ID: ${orderResult.orderId ?? 'N/A'}`,
                            ).catch((err) => console.error('[email] send failed:', err));
                            decisions.push({
                                symbol: position.symbol,
                                action: 'order_submitted',
                                score: 0,
                            });
                            decisionPushed = true;
                            break;
                        }
                        // status === 'filled' — proceed with trade record + position close
                        const filledSellPrice = orderResult.filledPrice ?? currentPrice;
                        await db.transaction(async (tx) => {
                            await insertTrade(tx, {
                                symbol: position.symbol,
                                side: 'sell',
                                orderType: 'market',
                                quantity: position.quantity,
                                price: filledSellPrice,
                                executedAt: new Date(),
                                reason: evaluation.reason,
                                mode: 'auto',
                                cronRunId,
                            });
                            await closePosition(tx, position.id, filledSellPrice);
                        });
                        currentExposure -= filledSellPrice * position.quantity;
                        if (currentExposure < 0) currentExposure = 0;
                        await sendTradeExecutedEmail({
                            symbol: position.symbol,
                            side: 'sell',
                            quantity: position.quantity,
                            price: filledSellPrice,
                            reason: evaluation.reason,
                            mode: 'auto',
                        });
                        break;
                    }
                }

                if (!decisionPushed) {
                    decisions.push({
                        symbol: position.symbol,
                        action: evaluation.action,
                        score: 0,
                    });
                }
            } catch (err) {
                await sendErrorEmail(position.symbol, String(err)).catch((err) =>
                    console.error('[email] send failed:', err),
                );
                decisions.push({ symbol: position.symbol, action: 'error', score: 0 });
            }
        }

        // Recalculate exposure after position closures using current market prices
        const updatedPositions = await getOpenPositions(db);
        currentExposure = 0;
        for (const p of updatedPositions) {
            let priceForRecalc = safeNumber(Number(p.avgPrice), 0);
            try {
                const techForRecalc = await getLatestAnalysisResult(db, p.symbol, 'technical');
                const recalcPrice = safeAnalysisPrice(techForRecalc?.result);
                if (recalcPrice > 0) priceForRecalc = recalcPrice;
            } catch {
                // Fall back to avgPrice when analysis data is unavailable
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
                const techAge = tech ? Date.now() - new Date(tech.analyzedAt).getTime() : Infinity;
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
                        if (overallResult.status === 'done' || overallResult.status === 'cached') {
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
                const currentPrice = safeAnalysisPrice(tech?.result);

                if (currentPrice === 0) {
                    decisions.push({ symbol: item.symbol, action: 'skipped_no_price', score: 0 });
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
                const decision = makeTradeDecision({
                    symbol: item.symbol,
                    signalScore,
                    hasOpenPosition: !!existingPosition,
                    positionQuantity: existingPosition?.quantity ?? 0,
                    calculatedSize,
                });

                // Stop-loss cooldown: skip buy signals for symbols closed by stop-loss in this run
                if (decision.action === 'buy' && recentStopLossSymbols.has(item.symbol)) {
                    decisions.push({
                        symbol: item.symbol,
                        action: 'cooldown_after_stop_loss',
                        score: decision.score,
                    });
                    continue;
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

                    await sendErrorEmail(
                        `잔고 부족: ${item.symbol}`,
                        `${item.symbol} 매수 신호 (${signalScore.total}/100) 발생했으나 잔고 부족으로 미실행.\n현재 총 노출: $${currentExposure.toFixed(2)} / 한도: $${maxTotalExposure}`,
                    ).catch((err) => console.error('[email] send failed:', err));

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

                // Mode transition guard: re-read volatile config before each trade.
                // Another admin may have disabled trading or changed mode mid-loop.
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
                const currentTradingMode =
                    (await getConfigValue<string>(db, 'trading_mode')) ?? 'dry_run';

                // Execute based on mode
                let decisionPushed = false;
                switch (currentTradingMode) {
                    case 'dry_run':
                        if (decision.action === 'buy') {
                            const existingDryRun = await getOpenPositionBySymbol(db, item.symbol);
                            await db.transaction(async (tx) => {
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
                                });
                                if (!existingDryRun) {
                                    await openPosition(tx, {
                                        symbol: item.symbol,
                                        side: 'long',
                                        quantity: decision.quantity,
                                        avgPrice: currentPrice,
                                    });
                                }
                            });
                            if (!existingDryRun) {
                                currentExposure += currentPrice * decision.quantity;
                            }
                        } else if (decision.action === 'sell') {
                            const existingSellPos = await getOpenPositionBySymbol(db, item.symbol);
                            await db.transaction(async (tx) => {
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
                                });
                                if (existingSellPos) {
                                    await closePosition(tx, existingSellPos.id, currentPrice);
                                }
                            });
                            currentExposure -= currentPrice * decision.quantity;
                            if (currentExposure < 0) currentExposure = 0;
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
                        await insertPendingOrder(db, {
                            symbol: item.symbol,
                            side: decision.action,
                            quantity: decision.quantity,
                            priceLimit: currentPrice,
                            analysisSummary: decision.reason,
                            signalScore: decision.score,
                            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
                        });
                        // Track pending order exposure to prevent over-allocation
                        if (decision.action === 'buy') {
                            currentExposure += currentPrice * decision.quantity;
                        }
                        await sendApprovalRequestEmail({
                            symbol: item.symbol,
                            side: decision.action,
                            quantity: decision.quantity,
                            score: decision.score,
                            reason: decision.reason,
                            approveUrl: 'https://auto-trade.siglens.io/pending',
                        }).catch((err) => console.error('[email] send failed:', err));
                        break;
                    }

                    case 'auto': {
                        const idempotencyKey = `${cronRunId}-${item.symbol}-${decision.action}`;
                        await createOrderTracking(db, {
                            idempotencyKey,
                            symbol: item.symbol,
                            side: decision.action,
                            quantity: decision.quantity,
                            status: 'submitted',
                            cronRunId,
                        });
                        const orderFn =
                            decision.action === 'buy' ? executeBuyOrder : executeSellOrder;
                        const orderResult = await orderFn(
                            item.symbol,
                            decision.quantity,
                            idempotencyKey,
                        );
                        await updateOrderTracking(db, idempotencyKey, {
                            tossOrderId: orderResult.orderId,
                            status: orderResult.status,
                            filledPrice: orderResult.filledPrice ?? undefined,
                            resolvedAt: orderResult.status !== 'submitted' ? new Date() : undefined,
                        });
                        if (orderResult.status === 'rejected') {
                            decisions.push({
                                symbol: item.symbol,
                                action: 'order_rejected',
                                score: decision.score,
                            });
                            decisionPushed = true;
                            await sendErrorEmail(
                                `주문 거부: ${item.symbol}`,
                                orderResult.message ?? '거부 사유 없음',
                            ).catch((err) => console.error('[email] send failed:', err));
                            break;
                        }
                        if (orderResult.status === 'submitted') {
                            await sendErrorEmail(
                                `미체결 주문: ${item.symbol}`,
                                `${item.symbol} ${decision.action} ${decision.quantity}주 주문이 접수되었으나 아직 체결되지 않았습니다. 주문 ID: ${orderResult.orderId ?? 'N/A'}`,
                            ).catch((err) => console.error('[email] send failed:', err));
                            decisions.push({
                                symbol: item.symbol,
                                action: 'order_submitted',
                                score: decision.score,
                            });
                            decisionPushed = true;
                            break;
                        }
                        // status === 'filled' — proceed with trade record + position
                        const filledPrice = orderResult.filledPrice ?? currentPrice;
                        if (decision.action === 'buy') {
                            const existingAuto = await getOpenPositionBySymbol(db, item.symbol);
                            await db.transaction(async (tx) => {
                                await insertTrade(tx, {
                                    symbol: item.symbol,
                                    side: decision.action,
                                    orderType: 'market',
                                    quantity: decision.quantity,
                                    price: filledPrice,
                                    executedAt: new Date(),
                                    reason: decision.reason,
                                    mode: 'auto',
                                    cronRunId,
                                });
                                if (!existingAuto) {
                                    await openPosition(tx, {
                                        symbol: item.symbol,
                                        side: 'long',
                                        quantity: decision.quantity,
                                        avgPrice: filledPrice,
                                    });
                                }
                            });
                            if (!existingAuto) {
                                currentExposure += filledPrice * decision.quantity;
                            }
                        } else if (decision.action === 'sell') {
                            const existingSellPos = await getOpenPositionBySymbol(db, item.symbol);
                            await db.transaction(async (tx) => {
                                await insertTrade(tx, {
                                    symbol: item.symbol,
                                    side: decision.action,
                                    orderType: 'market',
                                    quantity: decision.quantity,
                                    price: filledPrice,
                                    executedAt: new Date(),
                                    reason: decision.reason,
                                    mode: 'auto',
                                    cronRunId,
                                });
                                if (existingSellPos) {
                                    await closePosition(tx, existingSellPos.id, filledPrice);
                                }
                            });
                            currentExposure -= filledPrice * decision.quantity;
                            if (currentExposure < 0) currentExposure = 0;
                        } else {
                            await insertTrade(db, {
                                symbol: item.symbol,
                                side: decision.action,
                                orderType: 'market',
                                quantity: decision.quantity,
                                price: filledPrice,
                                executedAt: new Date(),
                                reason: decision.reason,
                                mode: 'auto',
                                cronRunId,
                            });
                        }
                        await sendTradeExecutedEmail({
                            symbol: item.symbol,
                            side: decision.action,
                            quantity: decision.quantity,
                            price: filledPrice,
                            reason: decision.reason,
                            mode: 'auto',
                        });
                        break;
                    }
                }

                if (!decisionPushed) {
                    decisions.push({
                        symbol: item.symbol,
                        action: decision.action,
                        score: decision.score,
                    });
                }
            } catch (err) {
                await sendErrorEmail(item.symbol, String(err)).catch((err) =>
                    console.error('[email] send failed:', err),
                );
                decisions.push({ symbol: item.symbol, action: 'error', score: 0 });
            }
        }

        return Response.json({ cronRunId, tradingMode, decisions });
    } finally {
        await releaseLock(LOCK_KEY);
    }
}
