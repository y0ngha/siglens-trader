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
} from '../../lib/db/queries';
import { runOverallAnalysis } from '../../lib/analysis/run-overall';
import { scoreSignals } from '../../lib/strategy/signal-scorer';
import { calculatePositionSize, evaluateExistingPosition } from '../../lib/strategy/risk-manager';
import { makeTradeDecision } from '../../lib/strategy/decision';
import { executeBuyOrder, executeSellOrder } from '../../lib/trading/orders';
import { getBuyingPower, getSellableQuantity, isUsMarketOpen } from '../../lib/trading/account';
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
import { isEtRegularSessionOpen } from '@y0ngha/siglens-core';
import { fetchLivePrice } from '../../lib/data/live-price';
import { safeNumber } from '../../lib/validation';
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
} from '../../lib/strategy/safe-extract';

/** Maximum age for analysis results before they are considered stale (4 hours). */
const MAX_ANALYSIS_AGE_MS = 4 * 60 * 60 * 1000;

export default async function handler(req: Request): Promise<Response> {
    if (!verifyCronSecret(req)) {
        return new Response('Unauthorized', { status: 401 });
    }

    // Skip trade execution outside the U.S. regular session (cron schedule is a static approximation)
    if (!isEtRegularSessionOpen(new Date())) {
        return Response.json({ skipped: true, reason: 'market_closed' });
    }

    const LOCK_KEY = 'cron:execute:lock';
    let lockAcquired = false;
    const locked = await acquireLock(LOCK_KEY);
    if (!locked) {
        return Response.json({ skipped: true, reason: 'another_execution_in_progress' });
    }
    lockAcquired = true;

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
                    const livePreCheck = await fetchLivePrice(pos.symbol).catch(() => null);
                    const techForPos = await getLatestAnalysisResult(db, pos.symbol, 'technical');
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

        // U.S. market-holiday gating (non-dry-run only). isEtRegularSessionOpen already
        // gated by wall-clock at entry; this catches holidays the static schedule misses.
        if (tradingMode !== 'dry_run') {
            const marketOpen = await isUsMarketOpen().catch(() => true); // 조회 실패 시 기존 시간기반 동작 유지
            if (!marketOpen) {
                return Response.json({ skipped: true, reason: 'us-market-holiday' });
            }
        }

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

        const cronRunId = `exec-${crypto.randomUUID()}`;
        const overallConfig = await getAnalysisConfig(db, 'overall');
        const decisions: Array<{ symbol: string; action: string; score: number }> = [];

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

        // USD buying power, fetched once per invocation (non-dry-run only).
        // null => guard disabled (fetch failed or dry_run) — fall back to prior behavior.
        const usdBuyingPower =
            tradingMode !== 'dry_run' ? await getBuyingPower('USD').catch(() => null) : null;

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
                        o.status === 'submitted',
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
                const techAge = tech ? Date.now() - new Date(tech.analyzedAt).getTime() : Infinity;
                if (techAge > MAX_ANALYSIS_AGE_MS) {
                    decisions.push({ symbol: position.symbol, action: 'stale_analysis', score: 0 });
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
                        try {
                            await db.transaction(async (tx) => {
                                const closed = await closePosition(tx, position.id, currentPrice);
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
                        // Sellable-quantity guard: confirm broker holds enough shares.
                        let sellQty = position.quantity;
                        const sellable = await getSellableQuantity(position.symbol).catch(
                            () => null,
                        );
                        if (sellable != null) {
                            if (sellable <= 0) {
                                decisions.push({
                                    symbol: position.symbol,
                                    action: 'skipped_not_sellable',
                                    score: 0,
                                });
                                decisionPushed = true;
                                break;
                            }
                            if (sellQty > sellable) {
                                sellQty = Math.floor(sellable);
                            }
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
                        const exitResolved =
                            orderResult.status !== 'pending' && orderResult.status !== 'partial';
                        await updateOrderTracking(db, exitIdempotencyKey, {
                            tossOrderId: orderResult.orderId || undefined,
                            status: orderResult.status,
                            filledPrice: orderResult.avgFilledPrice ?? undefined,
                            resolvedAt: exitResolved ? new Date() : undefined,
                        });
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
                            await sendErrorEmail(
                                `주문 거부: ${position.symbol}`,
                                orderResult.rejectReason ?? '거부 사유 없음',
                            ).catch((err) => console.error('[email] send failed:', err));
                            break;
                        }
                        if (orderResult.status === 'pending') {
                            await sendErrorEmail(
                                `미체결 주문: ${position.symbol}`,
                                `${position.symbol} sell ${sellQty}주 주문이 접수되었으나 아직 체결되지 않았습니다. 주문 ID: ${orderResult.orderId ?? 'N/A'}`,
                            ).catch((err) => console.error('[email] send failed:', err));
                            decisions.push({
                                symbol: position.symbol,
                                action: 'order_submitted',
                                score: 0,
                            });
                            decisionPushed = true;
                            break;
                        }
                        // status === 'filled' | 'partial' — record the filled portion.
                        const actualExitQty = orderResult.filledQuantity ?? sellQty;
                        if (orderResult.avgFilledPrice == null) {
                            // RARE: filled/partial but no avg price returned. Record at estimate.
                            // Keep 'partial' unresolved (reconcile resolves remainder); else mark unknown.
                            await updateOrderTracking(
                                db,
                                exitIdempotencyKey,
                                orderResult.status === 'partial'
                                    ? { status: 'partial' }
                                    : { status: 'fill_price_unknown', resolvedAt: new Date() },
                            );
                            await db.transaction(async (tx) => {
                                if (actualExitQty >= position.quantity) {
                                    const closed = await closePosition(
                                        tx,
                                        position.id,
                                        currentPrice,
                                    );
                                    if (!closed) throw new Error('POSITION_ALREADY_CLOSED');
                                } else {
                                    await reducePositionQuantity(tx, position.id, actualExitQty);
                                }
                                await insertTrade(tx, {
                                    symbol: position.symbol,
                                    side: 'sell',
                                    orderType: 'market',
                                    quantity: actualExitQty,
                                    price: currentPrice,
                                    executedAt: new Date(),
                                    reason: `체결가 미확인 — 예상가 $${currentPrice}로 기록 (수동 확인 필요)`,
                                    mode: 'auto',
                                    cronRunId,
                                });
                            });
                            currentExposure -= currentPrice * actualExitQty;
                            if (currentExposure < 0) currentExposure = 0;
                            await sendErrorEmail(
                                `체결가 누락: ${position.symbol}`,
                                `${position.symbol} 매도가 체결되었으나 체결가가 반환되지 않았습니다. 분석가 $${currentPrice}로 기록했습니다. 실제 체결가를 확인하여 수정해주세요.`,
                            ).catch((e) => console.error('[email]', e));
                            decisions.push({
                                symbol: position.symbol,
                                action: evaluation.action,
                                score: 0,
                            });
                            decisionPushed = true;
                            break;
                        }
                        const filledSellPrice = orderResult.avgFilledPrice;
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
                                    await reducePositionQuantity(tx, position.id, actualExitQty);
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
                        await sendTradeExecutedEmail({
                            symbol: position.symbol,
                            side: 'sell',
                            quantity: actualExitQty,
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
                    const techForRecalc = await getLatestAnalysisResult(db, p.symbol, 'technical');
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
                const currentPrice = priceCache.get(item.symbol) ?? safeAnalysisPrice(tech?.result);

                if (currentPrice <= 0) {
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
                            o.status === 'submitted',
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
                    const remainingSymbolBudget = Math.max(0, maxPositionSize - existingExposure);
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
                            const existingDryRun = await getOpenPositionBySymbol(db, item.symbol);
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
                            const existingSellPos = await getOpenPositionBySymbol(db, item.symbol);
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
                        await sendApprovalRequestEmail({
                            symbol: item.symbol,
                            side: pendingSide,
                            quantity: decision.quantity,
                            score: decision.score,
                            reason: decision.reason,
                            approveUrl: 'https://auto-trade.siglens.io/pending',
                        }).catch((err) => console.error('[email] send failed:', err));
                        break;
                    }

                    case 'auto': {
                        const autoSide = decision.action === 'average_in' ? 'buy' : decision.action;
                        const isBuyOrder =
                            decision.action === 'buy' || decision.action === 'average_in';
                        let autoQuantity = decision.quantity;

                        // Buying-power guard (BUY/average_in): skip if cost exceeds USD cash.
                        if (
                            isBuyOrder &&
                            usdBuyingPower != null &&
                            currentPrice * autoQuantity > usdBuyingPower
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
                                if (sellable <= 0) {
                                    decisions.push({
                                        symbol: item.symbol,
                                        action: 'skipped_not_sellable',
                                        score: decision.score,
                                    });
                                    decisionPushed = true;
                                    break;
                                }
                                if (autoQuantity > sellable) {
                                    autoQuantity = Math.floor(sellable);
                                }
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
                            orderResult = await orderFn(item.symbol, autoQuantity, clientOrderId);
                        } catch (apiErr) {
                            await updateOrderTracking(db, idempotencyKey, {
                                status: 'error',
                                resolvedAt: new Date(),
                            }).catch(() => {});
                            throw apiErr;
                        }
                        const autoResolved =
                            orderResult.status !== 'pending' && orderResult.status !== 'partial';
                        await updateOrderTracking(db, idempotencyKey, {
                            tossOrderId: orderResult.orderId || undefined,
                            status: orderResult.status,
                            filledPrice: orderResult.avgFilledPrice ?? undefined,
                            resolvedAt: autoResolved ? new Date() : undefined,
                        });
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
                            await sendErrorEmail(
                                `주문 거부: ${item.symbol}`,
                                orderResult.rejectReason ?? '거부 사유 없음',
                            ).catch((err) => console.error('[email] send failed:', err));
                            break;
                        }
                        if (orderResult.status === 'pending') {
                            await sendErrorEmail(
                                `미체결 주문: ${item.symbol}`,
                                `${item.symbol} ${decision.action} ${autoQuantity}주 주문이 접수되었으나 아직 체결되지 않았습니다. 주문 ID: ${orderResult.orderId ?? 'N/A'}`,
                            ).catch((err) => console.error('[email] send failed:', err));
                            decisions.push({
                                symbol: item.symbol,
                                action: 'order_submitted',
                                score: decision.score,
                            });
                            decisionPushed = true;
                            break;
                        }
                        // status === 'filled' | 'partial' — record filled portion at estimate if avg price missing
                        if (orderResult.avgFilledPrice == null) {
                            // RARE: filled/partial but no avg price returned. Record at estimate.
                            // Keep 'partial' unresolved (reconcile resolves remainder); else mark unknown.
                            await updateOrderTracking(
                                db,
                                idempotencyKey,
                                orderResult.status === 'partial'
                                    ? { status: 'partial' }
                                    : { status: 'fill_price_unknown', resolvedAt: new Date() },
                            );
                            const estimatedQty = orderResult.filledQuantity ?? autoQuantity;
                            if (decision.action === 'buy' || decision.action === 'average_in') {
                                const existingEstimated = await getOpenPositionBySymbol(
                                    db,
                                    item.symbol,
                                );
                                await db.transaction(async (tx) => {
                                    await insertTrade(tx, {
                                        symbol: item.symbol,
                                        side: autoSide,
                                        orderType: 'market',
                                        quantity: estimatedQty,
                                        price: currentPrice,
                                        executedAt: new Date(),
                                        reason: `체결가 미확인 — 예상가 $${currentPrice}로 기록 (수동 확인 필요)`,
                                        mode: 'auto',
                                        cronRunId,
                                    });
                                    if (existingEstimated) {
                                        await averageIntoPosition(
                                            tx,
                                            existingEstimated.id,
                                            estimatedQty,
                                            currentPrice,
                                        );
                                    } else {
                                        await openPosition(tx, {
                                            symbol: item.symbol,
                                            side: 'long',
                                            quantity: estimatedQty,
                                            avgPrice: currentPrice,
                                        });
                                    }
                                });
                                currentExposure += currentPrice * estimatedQty;
                            } else if (decision.action === 'sell') {
                                const existingSellEstimated = await getOpenPositionBySymbol(
                                    db,
                                    item.symbol,
                                );
                                if (existingSellEstimated) {
                                    await db.transaction(async (tx) => {
                                        if (estimatedQty >= existingSellEstimated.quantity) {
                                            const closed = await closePosition(
                                                tx,
                                                existingSellEstimated.id,
                                                currentPrice,
                                            );
                                            if (!closed) throw new Error('POSITION_ALREADY_CLOSED');
                                        } else {
                                            await reducePositionQuantity(
                                                tx,
                                                existingSellEstimated.id,
                                                estimatedQty,
                                            );
                                        }
                                        await insertTrade(tx, {
                                            symbol: item.symbol,
                                            side: autoSide,
                                            orderType: 'market',
                                            quantity: estimatedQty,
                                            price: currentPrice,
                                            executedAt: new Date(),
                                            reason: `체결가 미확인 — 예상가 $${currentPrice}로 기록 (수동 확인 필요)`,
                                            mode: 'auto',
                                            cronRunId,
                                        });
                                    });
                                    currentExposure -= currentPrice * estimatedQty;
                                    if (currentExposure < 0) currentExposure = 0;
                                }
                            }
                            await sendErrorEmail(
                                `체결가 누락: ${item.symbol}`,
                                `${item.symbol} ${autoSide} 주문이 체결되었으나 체결가가 반환되지 않았습니다. 분석가 $${currentPrice}로 기록했습니다. 실제 체결가를 확인하여 수정해주세요.`,
                            ).catch((e) => console.error('[email]', e));
                            decisions.push({
                                symbol: item.symbol,
                                action: decision.action,
                                score: decision.score,
                            });
                            decisionPushed = true;
                            break;
                        }
                        const filledPrice = orderResult.avgFilledPrice;
                        const actualQuantity = orderResult.filledQuantity ?? autoQuantity;
                        const quantityEstimated = !orderResult.filledQuantity;
                        if (
                            orderResult.filledQuantity &&
                            orderResult.filledQuantity < autoQuantity
                        ) {
                            await sendErrorEmail(
                                `부분 체결: ${item.symbol}`,
                                `${item.symbol} ${autoQuantity}주 중 ${actualQuantity}주만 체결되었습니다. 나머지 ${autoQuantity - actualQuantity}주는 미체결.`,
                            ).catch((e) => console.error('[email]', e));
                        }
                        if (!orderResult.filledQuantity) {
                            await sendErrorEmail(
                                `체결 수량 누락: ${item.symbol}`,
                                `${item.symbol} 주문이 체결되었으나 체결 수량이 반환되지 않았습니다. 요청 수량 ${autoQuantity}주로 기록합니다.`,
                            ).catch((e) => console.error('[email]', e));
                        }
                        const tradeReason = `${decision.reason}${quantityEstimated ? ' (수량 미확인 — 요청 수량으로 기록)' : ''}`;
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
                            });
                            currentExposure += filledPrice * actualQuantity;
                        } else if (decision.action === 'sell') {
                            const existingSellPos = await getOpenPositionBySymbol(db, item.symbol);
                            if (existingSellPos) {
                                try {
                                    await db.transaction(async (tx) => {
                                        if (actualQuantity >= existingSellPos.quantity) {
                                            const closed = await closePosition(
                                                tx,
                                                existingSellPos.id,
                                                filledPrice,
                                            );
                                            if (!closed) throw new Error('POSITION_ALREADY_CLOSED');
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
                                await insertTrade(db, {
                                    symbol: item.symbol,
                                    side: 'sell',
                                    orderType: 'market',
                                    quantity: actualQuantity,
                                    price: filledPrice,
                                    executedAt: new Date(),
                                    reason: `${tradeReason} (포지션 미확인 — 수동 확인 필요)`,
                                    mode: 'auto',
                                    cronRunId,
                                });
                                await sendErrorEmail(
                                    `포지션 미확인 매도 체결: ${item.symbol}`,
                                    `${item.symbol} ${actualQuantity}주가 체결되었으나 DB에 포지션이 없습니다.`,
                                ).catch((e) => console.error('[email]', e));
                            }
                        } else {
                            await insertTrade(db, {
                                symbol: item.symbol,
                                side: autoSide,
                                orderType: 'market',
                                quantity: actualQuantity,
                                price: filledPrice,
                                executedAt: new Date(),
                                reason: tradeReason,
                                mode: 'auto',
                                cronRunId,
                            });
                        }
                        await sendTradeExecutedEmail({
                            symbol: item.symbol,
                            side: autoSide,
                            quantity: actualQuantity,
                            price: filledPrice,
                            reason: tradeReason,
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
        if (lockAcquired) await releaseLock(LOCK_KEY);
    }
}
