export interface PositionEvaluation {
    action: 'hold' | 'take_profit' | 'stop_loss';
    reason: string;
}

export interface EvaluatePositionParams {
    avgPrice: number;
    currentPrice: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    /** When true, fixed stop-loss and take-profit checks are active. Default: false. */
    fixedExitEnabled?: boolean;
    /** from keyLevels.support[0] */
    supportLevel?: number;
    /** from keyLevels.resistance[0] */
    resistanceLevel?: number;
    /** from priceTargets.bullish.target */
    targetPrice?: number;
    /** if trend flipped to bearish -> close */
    technicalTrend?: string;
    /** if news turned bearish -> tighten stops */
    newsSentiment?: string;
    /** sell signal from overall -> close */
    overallSignal?: string;
}

interface PositionSizeParams {
    price: number;
    maxPositionSize: number;
    maxTotalExposure: number;
    currentExposure: number;
}

export function calculatePositionSize(params: PositionSizeParams): number {
    if (params.price <= 0) return 0;
    const remainingExposure = Math.max(0, params.maxTotalExposure - params.currentExposure);
    const budget = Math.min(params.maxPositionSize, remainingExposure);
    return Math.floor(budget / params.price);
}

export function shouldStopLoss(
    avgPrice: number,
    currentPrice: number,
    stopLossPercent: number,
): boolean {
    const lossPercent = ((avgPrice - currentPrice) / avgPrice) * 100;
    return lossPercent >= stopLossPercent;
}

export function shouldTakeProfit(
    avgPrice: number,
    currentPrice: number,
    takeProfitPercent: number,
): boolean {
    const gainPercent = ((currentPrice - avgPrice) / avgPrice) * 100;
    return gainPercent >= takeProfitPercent;
}

/**
 * Evaluates an existing open position using dynamic analysis-derived levels
 * (and optionally fixed thresholds) to decide whether to hold, take profit, or stop loss.
 *
 * Priority order:
 * 1. Fixed stop loss (only when fixedExitEnabled)
 * 2. Dynamic stop loss (support level break) — always active
 * 3. Technical trend reversal (bearish) — always active
 * 4. Fixed take profit (only when fixedExitEnabled)
 * 5. Dynamic take profit (resistance / target approach) — always active
 * 6. News-driven preemptive exit (bearish news + profit zone) — always active
 */
export function evaluateExistingPosition(params: EvaluatePositionParams): PositionEvaluation {
    const { avgPrice, currentPrice, stopLossPercent, takeProfitPercent } = params;

    // 1. Fixed stop loss check (only when enabled)
    if (params.fixedExitEnabled && shouldStopLoss(avgPrice, currentPrice, stopLossPercent)) {
        return { action: 'stop_loss', reason: `고정 손절선 도달 (-${stopLossPercent}%)` };
    }

    // 2. Dynamic stop loss: price broke below key support
    if (params.supportLevel && currentPrice < params.supportLevel) {
        return {
            action: 'stop_loss',
            reason: `지지선 이탈 (지지: $${params.supportLevel}, 현재: $${currentPrice})`,
        };
    }

    // 3. Technical trend reversal
    if (params.technicalTrend === 'bearish') {
        const gainPercent = ((currentPrice - avgPrice) / avgPrice) * 100;
        if (gainPercent > 0) {
            return { action: 'take_profit', reason: '기술적 추세 반전 — 수익 구간 익절' };
        }
        return { action: 'stop_loss', reason: '기술적 추세 반전 (bearish)' };
    }

    // 4. Fixed take profit check (only when enabled)
    if (params.fixedExitEnabled && shouldTakeProfit(avgPrice, currentPrice, takeProfitPercent)) {
        return { action: 'take_profit', reason: `고정 익절선 도달 (+${takeProfitPercent}%)` };
    }

    // 5. Dynamic take profit: approaching resistance or target
    if (params.resistanceLevel && currentPrice >= params.resistanceLevel * 0.98) {
        return {
            action: 'take_profit',
            reason: `저항선 근접 (저항: $${params.resistanceLevel})`,
        };
    }

    if (params.targetPrice && currentPrice >= params.targetPrice * 0.95) {
        return {
            action: 'take_profit',
            reason: `목표가 근접 (목표: $${params.targetPrice})`,
        };
    }

    // 6. News-driven exit
    if (params.newsSentiment === 'bearish' && params.technicalTrend !== 'bullish') {
        const gainPercent = ((currentPrice - avgPrice) / avgPrice) * 100;
        if (gainPercent > 0) {
            return { action: 'take_profit', reason: '뉴스 악재 + 수익 구간 — 선제 익절' };
        }
    }

    return { action: 'hold', reason: '유지 (조건 미충족)' };
}
