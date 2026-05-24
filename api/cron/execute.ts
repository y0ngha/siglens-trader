import { verifyCronSecret } from '../_lib/cron-auth';
import { getDb } from '../_lib/db';
import {
    getEnabledWatchlist,
    getConfigValue,
    getAnalysisConfig,
    getLatestAnalysisResult,
    getOpenPositions,
    getOpenPositionBySymbol,
    saveAnalysisResult,
    insertTrade,
    insertPendingOrder,
} from '../../lib/db/queries';
import { runOverallAnalysis } from '../../lib/analysis/run-overall';
import { scoreSignals } from '../../lib/strategy/signal-scorer';
import { calculatePositionSize } from '../../lib/strategy/risk-manager';
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

    const watchlistItems = await getEnabledWatchlist(db);
    if (watchlistItems.length === 0) {
        return Response.json({ skipped: true, reason: 'empty_watchlist' });
    }

    // Calculate current exposure
    const openPositions = await getOpenPositions(db);
    const currentExposure = openPositions.reduce(
        (sum, p) => sum + Number(p.avgPrice) * p.quantity,
        0,
    );

    const cronRunId = `exec-${Date.now()}`;
    const overallConfig = await getAnalysisConfig(db, 'overall');
    const decisions: Array<{ symbol: string; action: string; score: number }> = [];

    for (const item of watchlistItems) {
        try {
            // Gather latest analysis results
            const [tech, news, options, fundamental] = await Promise.all([
                getLatestAnalysisResult(db, item.symbol, 'technical'),
                getLatestAnalysisResult(db, item.symbol, 'news'),
                getLatestAnalysisResult(db, item.symbol, 'options'),
                getLatestAnalysisResult(db, item.symbol, 'fundamental'),
            ]);

            // Optional: run overall analysis
            let overall = null;
            if (overallConfig?.enabled) {
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
                    });
                    break;

                case 'auto': {
                    const orderFn = decision.action === 'buy' ? executeBuyOrder : executeSellOrder;
                    const orderResult = await orderFn(item.symbol, decision.quantity);
                    await insertTrade(db, {
                        symbol: item.symbol,
                        side: decision.action,
                        orderType: 'market',
                        quantity: decision.quantity,
                        price: orderResult.filledPrice ?? currentPrice,
                        executedAt: new Date(),
                        reason: decision.reason,
                        mode: 'auto',
                        cronRunId,
                    });
                    await sendTradeExecutedEmail({
                        symbol: item.symbol,
                        side: decision.action,
                        quantity: decision.quantity,
                        price: orderResult.filledPrice ?? currentPrice,
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
