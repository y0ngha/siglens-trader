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
    /**
     * 구조 훼손으로 나가는 청산인가 (지지선 이탈·추세 반전·하락 컨플루언스·분석 손절가 이탈).
     *
     * 이 넷은 수익 구간이면 `action: 'take_profit'`으로 라벨링되는데, 그 라벨은 손절 이력과
     * 재진입 쿨다운을 오염시키지 않기 위한 것이지 "목표를 달성했다"는 뜻이 아니다.
     * 사이징 게이트에는 이 값을 봐서 `structural` 트리거로 넘긴다 — 그러지 않으면 프롬프트가
     * '익절'을 읽고 구조가 깨진 포지션을 "일부만 덜어내고 나머지 태우기"로 판단한다.
     */
    structural?: boolean;
}

export interface EvaluatePositionParams {
    avgPrice: number;
    currentPrice: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    /** When true, fixed stop-loss and take-profit checks are active. Default: false. */
    fixedExitEnabled?: boolean;
    /**
     * 분석이 제시한 손절가 (`actionRecommendation.stopLoss`, core 보정값 우선).
     *
     * 고정 손절 %(`fixedExitEnabled`)는 기본 꺼져 있고, 나머지 손절 경로(지지선 이탈·추세
     * 반전·하락 컨플루언스)는 전부 **간접** 신호다. 이 값만이 "여기서 자른다"고 분석이
     * 명시한 가격인데 여태 규칙에서 읽히지 않고 사이징 게이트 프롬프트에만 들어갔다.
     */
    aiStopLoss?: number;
    /** 분석이 제시한 익절가 중 가장 가까운 것 (`actionRecommendation.takeProfitPrices[0]`). */
    aiTakeProfit?: number;
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
 * 지지선 이탈 손절의 허용 오차 (0.5%).
 *
 * `ENTRY_ZONE_TOLERANCE`(1%)와 같은 이유로 존재한다 — 선은 근사치이고 가격은 틱이다.
 * 익절 쪽 버퍼(2%·5%)보다 좁은 것은 의도적이다: 손절이 늦게 서면 그만큼 손실이 커진다.
 *
 * 진입 게이트(`hasStopRoom`)는 이 값을 **읽지 않는다.** 그쪽은 명목 지지선까지의 거리를
 * 재는데, 두 상수를 곱하면 한쪽을 조정할 때 다른 쪽 문턱이 조용히 따라 움직인다. 청산
 * 트리거는 여기서, 진입 여유는 `MIN_STOP_ROOM`에서 — 각각 독립으로 조정한다.
 */
export const SUPPORT_BREAK_BUFFER = 0.005;

/** 저항선 "근접" 밴드 하한 — 저항선 2% 아래부터 익절 후보. */
export const RESISTANCE_APPROACH_BAND = 0.02;

/**
 * 저항선 "근접" 밴드 상한 — 저항선 2% 위까지만 익절이고 그 위는 돌파다.
 *
 * 밴드를 벗어난 상승에서 익절이 서지 않는 것이 이 상수의 목적이다. 갭으로 밴드를
 * 건너뛴 포지션은 분석 익절가·목표가·구조 훼손 청산이 받는다.
 */
export const RESISTANCE_BREAKOUT_BAND = 0.02;

/**
 * Evaluates an existing open position using dynamic analysis-derived levels
 * (and optionally fixed thresholds) to decide whether to hold, take profit, or stop loss.
 *
 * Priority order:
 * 1. Fixed stop loss (only when fixedExitEnabled)
 * 1.5. 분석 손절가 이탈 (`aiStopLoss`) — always active
 * 2. Dynamic stop loss (support level break) — always active
 * 3. Technical trend reversal (bearish) — always active
 * 3.5. 하락 지표 컨플루언스 — always active
 * 4. Fixed take profit (only when fixedExitEnabled)
 * 4.5. 분석 익절가 도달 (`aiTakeProfit`) — always active
 * 5. Dynamic take profit (resistance approach) — **`aiTakeProfit`이 없을 때만** (4.5의 폴백)
 * 5b. Dynamic take profit (target approach) — always active
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

    // 1.5. 분석이 명시한 손절가 이탈.
    // 고정 손절선(1번) 바로 뒤 — 운영자가 직접 그은 선이 우선이고, 그다음이 분석이 그은
    // 선이며, 지지선 이탈 같은 간접 신호(2번 이하)는 그 뒤다.
    // `hard`를 세우지 않는 이유는 지지선 이탈과 같다 — 분석에서 파생된 판단이지 절대
    // 리스크 한계가 아니므로 사이징 게이트가 얼마나 자를지 정한다.
    // 익절(4.5)이 `>=`이므로 손절도 `<=`다 — `<`면 손절선에 정확히 닿았을 때만 트리거가
    // 빠져 리스크를 더 오래 들고 간다.
    if (params.aiStopLoss && currentPrice <= params.aiStopLoss) {
        // 수익 구간이면 익절로 라벨링한다 — 지지선 이탈(2번)·추세 반전(3번)과 같은 처리다.
        // 분석 손절가는 우리 매수가와 무관한 절대 가격이라, $100에 산 포지션이 $145까지
        // 오른 뒤 손절선 $140을 건드리는 일이 흔하다. 그걸 stop_loss로 기록하면 실현 수익이
        // 손절 이력으로 남고, `recentStopLossSymbols` 쿨다운까지 걸려 재진입이 막힌다.
        const gainPercent = ((currentPrice - avgPrice) / avgPrice) * 100;
        if (gainPercent >= 0) {
            return {
                action: 'take_profit',
                reason: `분석 손절가 이탈이나 수익 구간 — 익절 (손절: $${params.aiStopLoss})`,
                structural: true,
            };
        }
        return {
            action: 'stop_loss',
            reason: `분석 손절가 이탈 (손절: $${params.aiStopLoss}, 현재: $${currentPrice})`,
            structural: true,
        };
    }

    // 2. Dynamic stop loss: price broke below key support
    //
    // 지지선은 AI가 낸 근사치이고 현재가는 틱 단위로 움직인다. 버퍼 없이 `< supportLevel`로
    // 보면 0.03% 이탈 한 틱에 전량 청산이 나간다 — 실측(2026-08-19 PLTR): 175.65 매수,
    // 지지 175.60, 10분 뒤 175.5357에 청산. 시장 판단이 아니라 반올림 오차다.
    //
    // 익절 쪽은 이미 저항 `*0.98`(2%)·목표가 `*0.95`(5%)로 관대한데 손절만 오차 0이었다.
    // 그 비대칭이 곧 "익절은 일찍, 손절은 노이즈에" — 승률을 깎는 방향으로만 작동한다.
    // 익절 버퍼보다 좁게 잡는 이유는 손절이 더 늦게 서면 손실이 그만큼 커지기 때문이다.
    if (params.supportLevel && currentPrice < params.supportLevel * (1 - SUPPORT_BREAK_BUFFER)) {
        const gainPercent = ((currentPrice - avgPrice) / avgPrice) * 100;
        if (gainPercent >= 0) {
            return {
                action: 'take_profit',
                reason: `지지선 이탈이나 수익 구간 — 익절 (지지: $${params.supportLevel})`,
                structural: true,
            };
        }
        return {
            action: 'stop_loss',
            reason: `지지선 이탈 (지지: $${params.supportLevel}, 현재: $${currentPrice})`,
            structural: true,
        };
    }

    // 3. Technical trend reversal
    if (params.technicalTrend === 'bearish') {
        const gainPercent = ((currentPrice - avgPrice) / avgPrice) * 100;
        if (gainPercent >= 0) {
            return {
                action: 'take_profit',
                reason: '기술적 추세 반전 — 수익 구간 익절',
                structural: true,
            };
        }
        return { action: 'stop_loss', reason: '기술적 추세 반전 (bearish)', structural: true };
    }

    // 3.5. 하락 지표 컨플루언스: 진입 근거였던 룰이 반대 방향으로 성립했다.
    // 추세 반전(3번) 뒤에 두는 이유 — 그쪽이 이미 잡는 케이스를 중복 처리하지 않는다.
    // `hard`를 세우지 않는 이유 — 이건 지표 판단이지 절대 리스크 한계가 아니다.
    // 고정 손절선과 손상 데이터만 게이트를 건너뛴다.
    if (params.confluenceExit) {
        const gainPercent = ((currentPrice - avgPrice) / avgPrice) * 100;
        if (gainPercent >= 0) {
            return {
                action: 'take_profit',
                reason: '하락 지표 컨플루언스 — 수익 구간 익절',
                structural: true,
            };
        }
        return {
            action: 'stop_loss',
            reason: '하락 지표 컨플루언스 (약세 3종 + MA50 이탈)',
            structural: true,
        };
    }

    // 4. Fixed take profit check (only when enabled)
    if (params.fixedExitEnabled && shouldTakeProfit(avgPrice, currentPrice, takeProfitPercent)) {
        return { action: 'take_profit', reason: `고정 익절선 도달 (+${takeProfitPercent}%)` };
    }

    // 4.5. 분석이 명시한 익절가 도달. 손절 쪽(1.5)과 같은 자리 — 고정선 다음이 분석선이다.
    // 저항선/목표가 근접(5번)이 98%·95% 근사인 것과 달리 이건 명시 가격이라 근사를 쓰지
    // 않는다. 이 값이 없을 때 5번이 그대로 받는다 — 그 폴백 관계는 이제 5번 조건에
    // 실제로 적혀 있다. 종전에는 문장으로만 있었고 코드는 5번을 항상 돌렸다.
    if (params.aiTakeProfit && currentPrice >= params.aiTakeProfit) {
        return {
            action: 'take_profit',
            reason: `분석 익절가 도달 (익절: $${params.aiTakeProfit})`,
            // 손실 구간이면 `structural`을 세운다 — 1.5번의 거울상이다.
            //
            // 분석 익절가는 손절가와 마찬가지로 **우리 매수가와 무관한 절대 가격**이라,
            // 분석이 그린 그림보다 비싸게 산 포지션은 미실현 손실 상태에서 이 선에 닿는다
            // (실측 2026-08-13: 178.53에 사고 레벨은 ~174 기준). 그때 게이트에 `take_profit`
            // 트리거가 그대로 가면 프롬프트가 "목표 달성형"으로 읽고 일부만 덜어낸 뒤
            // 나머지를 태운다 — 손실 포지션에 정확히 반대되는 사이징이다.
            // 라벨을 `stop_loss`로 바꾸지는 않는다: 그러면 재진입 쿨다운과 손절 이력이
            // 오염된다(1.5번 주석과 같은 이유).
            ...(currentPrice < avgPrice ? { structural: true } : {}),
        };
    }

    // 5. Dynamic take profit: approaching resistance — **4.5의 폴백일 때만.**
    //
    // 4.5가 "이 값이 없을 때 5번이 그대로 받는다"고 적어 둔 그 폴백이다. 그런데 조건이
    // 없어서 **항상** 돌았고, `aiTakeProfit`보다 낮은 자리에서 먼저 서기 때문에(실측 75%)
    // 자기가 받쳐 주기로 한 규칙을 가로챘다.
    //
    // 왜 상수인가 — `keyLevels.resistance[0]`은 정의상 **현재가에서 가장 가까운** 저항이고
    // 매시간 다시 계산돼 가격을 따라다닌다. 실측(706틱): 현재가 대비 중앙 **+0.19%**로,
    // 1Hour 실현 이동 중앙값(0.25~0.49%)보다 **작다**. 거기에 ±2% 밴드를 씌우니
    // **99.2%의 틱에서 조건이 참**이었다. 신호가 아니라 상수다 — congress 축과 같은 형태다.
    //
    // 결과는 "사자마자 청산"이다. 실측(705 표본, 매 틱 매수 → 다음 틱 평가): 청산되지 않는
    // 경우가 **0%**. 프로덕션 실거래도 그렇게 났다 — 2026-09-02 NVDA를 227.53에 사고
    // (저항 227, **매수가보다 아래**) 10분 뒤 227.45에 청산, 즉 체결되는 순간 이미 조건이
    // 서 있었다.
    //
    // 폴백으로 되돌리면 자기 자리를 찾는다. `aiTakeProfit`은 실측 99% 존재하고(그중 82%는
    // AI 원본, 18%는 core의 ATR 폴백) 현재가 대비 중앙 **+0.70%** — 노이즈 밖의 진짜 목표다.
    // 리플레이(702 표본): 규칙 4.5 발동이 93건(평균 +0.370%) → 275건(평균 **+1.360%**),
    // 거래당 평균 −0.024% → **+0.229%**, 보유 중앙값 10분 → 30분.
    //
    // **이 변경은 청산을 느슨하게 만든다** — 원칙 7이 요구하는 방향 선언이다. 조이는 쪽이
    // 아니므로 진입에는 영향이 없다. 리스크 컨트롤(1.5 분석손절가 / 2 지지선 이탈 /
    // 3 추세 반전 / 3.5 하락 컨플루언스)은 그대로이고 각각 4~6%의 틱에서 발동한다.
    // 다만 손실 꼬리가 두꺼워진다는 것은 사실이다(리플레이 p05 −0.70% → −2.44%) —
    // 규칙 5가 이익도 손실도 함께 잘라 내던 것이 없어지고 분석 손절가가 그 자리를 받는다.
    //
    // **밴드는 그대로 둔다.** 하한만 두면 돌파가 저항 거부로 오독된다 — 종전 조건은
    // `>= r*0.98`뿐이라 가격이 저항선을 아무리 크게 넘어도 계속 참이었다(실측 2026-08-13
    // PLTR: 저항 172.33에 현재가 176.375). 목표가 위는 "도달했다"이므로 익절이 맞지만
    // (아래 5b는 그대로 상한 없이 둔다) 저항선 위는 "뚫었다"이고 그건 파는 이유가 아니다.
    if (
        !params.aiTakeProfit &&
        params.resistanceLevel &&
        currentPrice >= params.resistanceLevel * (1 - RESISTANCE_APPROACH_BAND) &&
        currentPrice <= params.resistanceLevel * (1 + RESISTANCE_BREAKOUT_BAND)
    ) {
        return {
            action: 'take_profit',
            reason: `저항선 근접 (저항: $${params.resistanceLevel})`,
            ...(currentPrice < avgPrice ? { structural: true } : {}),
        };
    }

    if (params.targetPrice && currentPrice >= params.targetPrice * 0.95) {
        return {
            action: 'take_profit',
            reason: `목표가 근접 (목표: $${params.targetPrice})`,
            ...(currentPrice < avgPrice ? { structural: true } : {}),
        };
    }

    // 6. News-driven exit
    if (params.newsSentiment === 'bearish' && params.technicalTrend !== 'bullish') {
        const gainPercent = ((currentPrice - avgPrice) / avgPrice) * 100;
        if (gainPercent >= 0) {
            return {
                action: 'take_profit',
                reason: '뉴스 악재 + 수익 구간 — 선제 익절',
                structural: true,
            };
        }
        return { action: 'stop_loss', reason: '뉴스 악재 + 손실 구간 — 손절', structural: true };
    }

    return { action: 'hold', reason: '유지 (조건 미충족)' };
}
