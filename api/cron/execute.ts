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

export default async function handler(req: Request): Promise<Response> {
    if (!verifyCronSecret(req)) {
        return new Response('Unauthorized', { status: 401 });
    }

    const db = getDb();

    // Load config
    const tradingMode = (await getConfigValue<string>(db, 'trading_mode')) ?? 'dry_run';
    const maxPositionSize = (await getConfigValue<number>(db, 'max_position_size')) ?? 1000;
    const maxTotalExposure = (await getConfigValue<number>(db, 'max_total_exposure')) ?? 5000;
    const weights = (await getConfigValue<ScoreWeights>(db, 'score_weights')) ?? DEFAULT_WEIGHTS;
    const buyThreshold =
        (await getConfigValue<number>(db, 'buy_threshold')) ?? DEFAULT_BUY_THRESHOLD;
    const sellThreshold =
        (await getConfigValue<number>(db, 'sell_threshold')) ?? DEFAULT_SELL_THRESHOLD;

    const stopLossPercent = (await getConfigValue<number>(db, 'stop_loss_percent')) ?? 5;
    const takeProfitPercent = (await getConfigValue<number>(db, 'take_profit_percent')) ?? 10;

    const watchlistItems = await getEnabledWatchlist(db);

    // Calculate current exposure
    const openPositions = await getOpenPositions(db);

    if (watchlistItems.length === 0 && openPositions.length === 0) {
        return Response.json({ skipped: true, reason: 'empty_watchlist' });
    }

    let currentExposure = openPositions.reduce(
        (sum, p) => sum + Number(p.avgPrice) * p.quantity,
        0,
    );

    const cronRunId = `exec-${Date.now()}`;
    const overallConfig = await getAnalysisConfig(db, 'overall');
    const decisions: Array<{ symbol: string; action: string; score: number }> = [];

    // --- Position re-evaluation ---
    for (const position of openPositions) {
        try {
            const [tech, news] = await Promise.all([
                getLatestAnalysisResult(db, position.symbol, 'technical'),
                getLatestAnalysisResult(db, position.symbol, 'news'),
            ]);

            const techResult = tech?.result as any;
            const currentPrice: number = techResult?.keyLevels?.currentPrice ?? 0;
            if (currentPrice === 0) {
                decisions.push({ symbol: position.symbol, action: 'skipped_no_price', score: 0 });
                continue;
            }

            const evaluation = evaluateExistingPosition({
                avgPrice: Number(position.avgPrice),
                currentPrice,
                stopLossPercent,
                takeProfitPercent,
                supportLevel: techResult?.keyLevels?.support?.[0],
                resistanceLevel: techResult?.keyLevels?.resistance?.[0],
                targetPrice: techResult?.priceTargets?.bullish?.target,
                technicalTrend: techResult?.trend,
                newsSentiment: (news?.result as any)?.overallSentiment,
            });

            if (evaluation.action === 'hold') continue;

            // Execute the exit
            switch (tradingMode) {
                case 'dry_run':
                    await insertTrade(db, {
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
                    await closePosition(db, position.id, currentPrice);
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
                    }).catch(() => {});
                    break;

                case 'auto': {
                    const orderResult = await executeSellOrder(position.symbol, position.quantity);
                    await insertTrade(db, {
                        symbol: position.symbol,
                        side: 'sell',
                        orderType: 'market',
                        quantity: position.quantity,
                        price: orderResult.filledPrice ?? currentPrice,
                        executedAt: new Date(),
                        reason: evaluation.reason,
                        mode: 'auto',
                        cronRunId,
                    });
                    await closePosition(db, position.id, orderResult.filledPrice ?? currentPrice);
                    await sendTradeExecutedEmail({
                        symbol: position.symbol,
                        side: 'sell',
                        quantity: position.quantity,
                        price: orderResult.filledPrice ?? currentPrice,
                        reason: evaluation.reason,
                        mode: 'auto',
                    });
                    break;
                }
            }

            decisions.push({ symbol: position.symbol, action: evaluation.action, score: 0 });
        } catch (err) {
            await sendErrorEmail(position.symbol, String(err)).catch(() => {});
            decisions.push({ symbol: position.symbol, action: 'error', score: 0 });
        }
    }

    // Recalculate exposure after position closures
    const updatedPositions = await getOpenPositions(db);
    currentExposure = updatedPositions.reduce((sum, p) => sum + Number(p.avgPrice) * p.quantity, 0);

    for (const item of watchlistItems) {
        try {
            // Gather latest analysis results
            const [tech, news, options, fundamental] = await Promise.all([
                getLatestAnalysisResult(db, item.symbol, 'technical'),
                getLatestAnalysisResult(db, item.symbol, 'news'),
                getLatestAnalysisResult(db, item.symbol, 'options'),
                getLatestAnalysisResult(db, item.symbol, 'fundamental'),
            ]);

            // Optional: run overall analysis (skip if recent cache exists)
            let overall = null;
            if (overallConfig?.enabled) {
                const existingOverall = await getLatestAnalysisResult(db, item.symbol, 'overall');
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

            // Score signals
            const signalScore = scoreSignals(
                {
                    technical: (tech?.result as any) ?? null,
                    news: (news?.result as any) ?? null,
                    options: (options?.result as any) ?? null,
                    fundamental: (fundamental?.result as any) ?? null,
                    overall: (overall as any) ?? null,
                },
                weights,
                buyThreshold,
                sellThreshold,
            );

            // Position + pricing
            const existingPosition = await getOpenPositionBySymbol(db, item.symbol);
            const currentPrice = (tech?.result as any)?.keyLevels?.currentPrice ?? 0;

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

            // Make decision
            const decision = makeTradeDecision({
                symbol: item.symbol,
                signalScore,
                hasOpenPosition: !!existingPosition,
                positionQuantity: existingPosition?.quantity ?? 0,
                calculatedSize,
            });

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
                ).catch(() => {});

                decisions.push({
                    symbol: item.symbol,
                    action: 'skipped',
                    score: signalScore.total,
                });
                continue;
            }

            decisions.push({ symbol: item.symbol, action: decision.action, score: decision.score });

            if (decision.action === 'hold') continue;

            // Execute based on mode
            switch (tradingMode) {
                case 'dry_run':
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
                    if (decision.action === 'buy') {
                        await openPosition(db, {
                            symbol: item.symbol,
                            side: 'long',
                            quantity: decision.quantity,
                            avgPrice: currentPrice,
                        });
                        currentExposure += currentPrice * decision.quantity;
                    }
                    break;

                case 'semi_auto':
                    await insertPendingOrder(db, {
                        symbol: item.symbol,
                        side: decision.action,
                        quantity: decision.quantity,
                        priceLimit: currentPrice,
                        analysisSummary: decision.reason,
                        signalScore: decision.score,
                        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
                    });
                    await sendApprovalRequestEmail({
                        symbol: item.symbol,
                        side: decision.action,
                        quantity: decision.quantity,
                        score: decision.score,
                        reason: decision.reason,
                        approveUrl: 'https://auto-trade.siglens.io/pending',
                    }).catch(() => {});
                    break;

                case 'auto': {
                    const orderFn = decision.action === 'buy' ? executeBuyOrder : executeSellOrder;
                    const orderResult = await orderFn(item.symbol, decision.quantity);
                    const filledPrice = orderResult.filledPrice ?? currentPrice;
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
                    if (decision.action === 'buy') {
                        await openPosition(db, {
                            symbol: item.symbol,
                            side: 'long',
                            quantity: decision.quantity,
                            avgPrice: filledPrice,
                        });
                        currentExposure += filledPrice * decision.quantity;
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
        } catch (err) {
            await sendErrorEmail(item.symbol, String(err)).catch(() => {});
            decisions.push({ symbol: item.symbol, action: 'error', score: 0 });
        }
    }

    return Response.json({ cronRunId, tradingMode, decisions });
}
