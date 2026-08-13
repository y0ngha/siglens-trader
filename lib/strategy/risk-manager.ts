export interface PositionEvaluation {
    action: 'hold' | 'take_profit' | 'stop_loss';
    reason: string;
    /**
     * True only for exits the AI trade gate must never override: corrupt price data
     * and the operator's own fixed stop-loss line. Both are absolute risk controls,
     * not judgment calls — the gate is a position *sizer*, not a risk override.
     * Take-profit (fixed or dynamic) and the other stop_loss branches (support break,
     * trend reversal, bearish news) are analysis-derived opinions, not hard limits,
     * so they leave `hard` unset and let the gate decide how much to sell.
     */
    hard?: boolean;
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
    /**
     * 하락 지표 컨플루언스가 성립했는가 (`isConfluenceExit`의 결과).
     *
     * 백테스트 진입 룰이 온전히 뒤집힌 상태 — 약세 시그널 3종 이상 + 신규 1종 이상 +
     * 종가가 MA50 아래. 진입에 쓴 근거가 사라졌다는 뜻이므로 청산 사유가 된다.
     */
    confluenceExit?: boolean;
}

interface PositionSizeParams {
    price: number;
    maxPositionSize: number;
    maxTotalExposure: number;
    currentExposure: number;
}

export function calculatePositionSize(params: PositionSizeParams): number {
    if (!Number.isFinite(params.price) || params.price <= 0) return 0;
    const remainingExposure = Math.max(0, params.maxTotalExposure - params.currentExposure);
    const budget = Math.min(params.maxPositionSize, remainingExposure);
    return Math.floor(budget / params.price);
}

export function shouldStopLoss(
    avgPrice: number,
    currentPrice: number,
    stopLossPercent: number,
): boolean {
    if (!Number.isFinite(avgPrice) || avgPrice <= 0) return false;
    if (!Number.isFinite(currentPrice)) return false;
    const lossPercent = ((avgPrice - currentPrice) / avgPrice) * 100;
    return lossPercent >= stopLossPercent;
}

export function shouldTakeProfit(
    avgPrice: number,
    currentPrice: number,
    takeProfitPercent: number,
): boolean {
    if (!Number.isFinite(avgPrice) || avgPrice <= 0) return false;
    if (!Number.isFinite(currentPrice)) return false;
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
 * 3.5. 하락 지표 컨플루언스 — always active
 * 4. Fixed take profit (only when fixedExitEnabled)
 * 5. Dynamic take profit (resistance / target approach) — always active
 * 6. News-driven preemptive exit (bearish news + profit zone) — always active
 */
export function evaluateExistingPosition(params: EvaluatePositionParams): PositionEvaluation {
    const { avgPrice, currentPrice, stopLossPercent, takeProfitPercent } = params;

    // Guard: invalid avgPrice — trigger stop_loss so the position gets closed and
    // an alert email is sent. Silently holding a corrupt position is dangerous.
    // hard: true — this is corrupt data, not a judgment call, so the gate never sees it.
    if (!Number.isFinite(avgPrice) || avgPrice <= 0) {
        return { action: 'stop_loss', reason: '유효하지 않은 매수가 — 수동 확인 필요', hard: true };
    }
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        return { action: 'stop_loss', reason: '유효하지 않은 현재가 — 수동 확인 필요', hard: true };
    }

    // 1. Fixed stop loss check (only when enabled)
    // hard: true — the operator set this line explicitly; it is an absolute risk
    // control, not a target the AI gate gets to soften.
    if (params.fixedExitEnabled && shouldStopLoss(avgPrice, currentPrice, stopLossPercent)) {
        return {
            action: 'stop_loss',
            reason: `고정 손절선 도달 (-${stopLossPercent}%)`,
            hard: true,
        };
    }

    // 2. Dynamic stop loss: price broke below key support
    if (params.supportLevel && currentPrice < params.supportLevel) {
        const gainPercent = ((currentPrice - avgPrice) / avgPrice) * 100;
        if (gainPercent >= 0) {
            return {
                action: 'take_profit',
                reason: `지지선 이탈이나 수익 구간 — 익절 (지지: $${params.supportLevel})`,
            };
        }
        return {
            action: 'stop_loss',
            reason: `지지선 이탈 (지지: $${params.supportLevel}, 현재: $${currentPrice})`,
        };
    }

    // 3. Technical trend reversal
    if (params.technicalTrend === 'bearish') {
        const gainPercent = ((currentPrice - avgPrice) / avgPrice) * 100;
        if (gainPercent >= 0) {
            return { action: 'take_profit', reason: '기술적 추세 반전 — 수익 구간 익절' };
        }
        return { action: 'stop_loss', reason: '기술적 추세 반전 (bearish)' };
    }

    // 3.5. 하락 지표 컨플루언스: 진입 근거였던 룰이 반대 방향으로 성립했다.
    // 추세 반전(3번) 뒤에 두는 이유 — 그쪽이 이미 잡는 케이스를 중복 처리하지 않는다.
    // `hard`를 세우지 않는 이유 — 이건 지표 판단이지 절대 리스크 한계가 아니다.
    // 고정 손절선과 손상 데이터만 게이트를 건너뛴다.
    if (params.confluenceExit) {
        const gainPercent = ((currentPrice - avgPrice) / avgPrice) * 100;
        if (gainPercent >= 0) {
            return { action: 'take_profit', reason: '하락 지표 컨플루언스 — 수익 구간 익절' };
        }
        return { action: 'stop_loss', reason: '하락 지표 컨플루언스 (약세 3종 + MA50 이탈)' };
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
        if (gainPercent >= 0) {
            return { action: 'take_profit', reason: '뉴스 악재 + 수익 구간 — 선제 익절' };
        }
        return { action: 'stop_loss', reason: '뉴스 악재 + 손실 구간 — 손절' };
    }

    return { action: 'hold', reason: '유지 (조건 미충족)' };
}
