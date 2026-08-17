import { isFinitePositive } from '../validation.js';

/**
 * Safe extraction helpers for untyped AI analysis results.
 * These functions defensively parse nested JSON returned by LLM analysis
 * and return safe default values instead of throwing on unexpected shapes.
 */

export function safeRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return null;
}

export function safeString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/**
 * `safeAnalysisPrice`는 삭제됐다. 읽던 `keyLevels.currentPrice`가 siglens-core에 **존재하지
 * 않는 필드**라 프로덕션에서 항상 0을 반환했기 때문이다 — core의 `KeyLevels`는
 * `{ support, resistance, poc }` 셋뿐이고, `normalizeKeyLevels`가 객체를 그 세 키로 재구성하며,
 * `currentPrice`는 core 타입 전체에 등장하지 않는다.
 *
 * 그 결과 (1) FMP 호가 실패 시 쓸 폴백 가격이 없어 그 심볼이 통째로 스킵됐고
 * (2) 25% 시세 교차검증(`MAX_PRICE_SOURCE_DIVERGENCE`)이 한 번도 발동한 적 없었다.
 *
 * 대체 소스는 **컨플루언스 스냅샷의 `close`**(FMP OHLC 마지막 봉 종가)다. 교차검증 주석이
 * 원래 의도한 비교(quote 엔드포인트 vs OHLC)가 정확히 그것이고, execute cron이 이미 심볼당
 * 한 번 계산해 캐시하고 있어 추가 조회가 없다. `api/cron/execute.ts`의 `snapshotPriceOf` 참조.
 */

export function safeAnalysisTrend(result: unknown): string | undefined {
    const r = safeRecord(result);
    return r ? safeString(r.trend) : undefined;
}

export function safeAnalysisSentiment(result: unknown): string | undefined {
    const r = safeRecord(result);
    return r ? safeString(r.overallSentiment) : undefined;
}

export function safeNumberArray(value: unknown): number[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const nums = value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return nums.length > 0 ? nums : undefined;
}

/**
 * Extracts price levels from a support/resistance array. siglens-core's actual
 * `KeyLevels.support`/`.resistance` shape is `{ price: number; reason: string }[]`,
 * not bare numbers — `safeNumberArray` (which only keeps `typeof v === 'number'`
 * elements) silently drops every element of that shape and returns `undefined`,
 * which is how `safeAnalysisSupport`/`safeAnalysisResistance` ended up always
 * returning `undefined` in production even though the data was there. Accept both
 * shapes — bare numbers (older/manually-constructed test fixtures) and `{ price }`
 * objects (the real core shape) — so a future shape shift degrades instead of
 * silently zeroing out two of the six exit-evaluation branches again.
 */
export function safePriceLevelArray(value: unknown): number[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const levels: number[] = [];
    for (const v of value) {
        if (isFinitePositive(v)) {
            levels.push(v);
            continue;
        }
        const r = safeRecord(v);
        if (r && isFinitePositive(r.price)) {
            levels.push(r.price);
        }
    }
    return levels.length > 0 ? levels : undefined;
}

export function safeAnalysisSupport(result: unknown): number | undefined {
    const r = safeRecord(result);
    if (!r) return undefined;
    const keyLevels = safeRecord(r.keyLevels);
    if (!keyLevels) return undefined;
    const levels = safePriceLevelArray(keyLevels.support);
    return levels?.[0];
}

export function safeAnalysisResistance(result: unknown): number | undefined {
    const r = safeRecord(result);
    if (!r) return undefined;
    const keyLevels = safeRecord(r.keyLevels);
    if (!keyLevels) return undefined;
    const levels = safePriceLevelArray(keyLevels.resistance);
    return levels?.[0];
}

/** One side of `priceTargets`: the projected levels plus the condition that triggers them. */
export interface AnalysisPriceScenario {
    targets: number[];
    condition?: string;
}

/**
 * Extracts one side of `priceTargets` (`bullish` = upside scenario, `bearish` = downside).
 *
 * siglens-core's real shape is `PriceScenario | null` =
 * `{ targets: { price: number; basis: string }[]; condition: string }` — there is **no**
 * `target` scalar. Reading `bullish.target` (which this module used to do) therefore always
 * produced `undefined` in production, silently killing the 95%-of-target take-profit branch
 * in `evaluateExistingPosition`. Same failure mode as the old `safeAnalysisSupport` bug, so
 * the fix is the same: go through `safePriceLevelArray`, which already accepts both the real
 * `{ price }` object shape and bare numbers. The legacy `{ target: number }` scalar is still
 * accepted so previously-stored analysis rows keep resolving.
 */
export function safeAnalysisPriceScenario(
    result: unknown,
    side: 'bullish' | 'bearish',
): AnalysisPriceScenario | undefined {
    const priceTargets = safeRecord(safeRecord(result)?.priceTargets);
    if (!priceTargets) return undefined;
    const scenario = safeRecord(priceTargets[side]);
    if (!scenario) return undefined;
    const targets = safePriceLevelArray(scenario.targets) ?? safePriceLevelArray([scenario.target]);
    if (!targets) return undefined;
    return { targets, condition: safeString(scenario.condition) };
}

/**
 * First (nearest) bullish price target. Return contract is deliberately a single `number`
 * — `api/cron/execute.ts` feeds it straight into `evaluateExistingPosition({ targetPrice })`.
 * Use `safeAnalysisPriceScenario` when the full ladder or the trigger condition is needed.
 */
export function safeAnalysisTargetPrice(result: unknown): number | undefined {
    return safeAnalysisPriceScenario(result, 'bullish')?.targets[0];
}

/**
 * `actionRecommendation`에서 가격 세 개를 읽는다 — 권장 진입 구간, 손절가, 익절가.
 *
 * `safeActionRecommendation`은 `entryRecommendation` 하나만 돌려주고 그 값이 유효하지
 * 않으면 통째로 `undefined`가 되므로, 가격은 여기서 따로 읽는다.
 *
 * **`reconciledLevels`가 있으면 그쪽이 이긴다.** core는 AI가 낸 손절/익절이 유효하지 않을
 * 때(예: 손절가가 현재가 위) 원본을 그대로 두고 도메인 보정값을 `reconciledLevels`에 따로
 * 붙인다. 원본을 그대로 트리거로 쓰면 core가 "이 값은 못 쓴다"고 판정한 숫자로 청산하게
 * 되므로, 보정값이 있으면 그 자리를 대체한다. `lib/analysis/trade-gate.ts`의 프롬프트가
 * 같은 규칙으로 렌더한다.
 */
function actionRecommendationRecords(result: unknown): {
    rec: Record<string, unknown> | null;
    reconciled: Record<string, unknown> | null;
} {
    const rec = safeRecord(safeRecord(result)?.actionRecommendation);
    return { rec, reconciled: safeRecord(rec?.reconciledLevels) };
}

/**
 * 권장 진입 구간. 없으면 빈 배열 — `exceedsEntryZone`이 빈 배열을 "판단 불가 → 통과"로 읽는다.
 *
 * 여기만 보정값을 보지 않는다: core의 `ReconciledActionLevels`에는 `stopLoss`와
 * `takeProfitPrices`만 있고 진입 구간은 보정 대상이 아니다.
 */
export function safeAnalysisEntryPrices(result: unknown): number[] {
    return safePriceLevelArray(actionRecommendationRecords(result).rec?.entryPrices) ?? [];
}

/** AI가 제시한 손절가 (보정값 우선). `evaluateExistingPosition`의 손절 트리거. */
export function safeAnalysisStopLoss(result: unknown): number | undefined {
    const { rec, reconciled } = actionRecommendationRecords(result);
    for (const candidate of [reconciled?.stopLoss, rec?.stopLoss]) {
        if (isFinitePositive(candidate)) return candidate;
    }
    return undefined;
}

/**
 * AI가 제시한 익절가 중 **가장 가까운 것** (보정값 우선).
 *
 * 사다리 전체가 아니라 첫 칸만 쓰는 이유는 `safeAnalysisTargetPrice`와 같다 — 트리거는
 * "여기 닿으면 판다"는 단일 숫자여야 하고, 먼저 닿는 것은 첫 칸이다.
 */
export function safeAnalysisTakeProfit(result: unknown): number | undefined {
    const { rec, reconciled } = actionRecommendationRecords(result);
    const levels =
        safePriceLevelArray(reconciled?.takeProfitPrices) ??
        safePriceLevelArray(rec?.takeProfitPrices);
    return levels?.[0];
}

/** `patternSummaries` / `strategyResults` / `candlePatterns`가 공통으로 갖는 방향 신호. */
export interface AnalysisPatternSignal {
    trend?: string;
    confidenceWeight?: number;
    detected?: boolean;
}

/**
 * core가 방향(`trend`)과 신뢰도 가중치(`confidenceWeight`)까지 붙여 내는 세 배열을 하나로 모은다.
 *
 * `patternSummaries`(차트 패턴), `strategyResults`(전략 스킬 판정), `candlePatterns`(캔들 패턴)는
 * 전부 `trend: Trend`를 갖고 앞의 둘은 `confidenceWeight`도 갖는데, 이 저장소 어디에서도 읽히지
 * 않고 있었다 — 죽은 추출(잘못된 모양을 읽어 undefined)이 아니라 **아예 배선되지 않은** 신호다.
 * `detected: false`인 항목은 방향을 주장하지 않으므로 호출부에서 걸러진다.
 */
export function safeAnalysisPatterns(result: unknown): AnalysisPatternSignal[] {
    const r = safeRecord(result);
    if (!r) return [];
    const out: AnalysisPatternSignal[] = [];
    for (const key of ['patternSummaries', 'strategyResults', 'candlePatterns']) {
        for (const item of safeArray(r, key) ?? []) {
            const rec = safeRecord(item);
            if (!rec) continue;
            const trend = safeString(rec.trend);
            if (trend === undefined) continue;
            out.push({
                trend,
                confidenceWeight: isFinitePositive(rec.confidenceWeight)
                    ? rec.confidenceWeight
                    : undefined,
                detected: typeof rec.detected === 'boolean' ? rec.detected : undefined,
            });
        }
    }
    return out;
}

export function safeArray(obj: unknown, key: string): unknown[] | undefined {
    const r = safeRecord(obj);
    if (!r) return undefined;
    const val = r[key];
    return Array.isArray(val) ? val : undefined;
}

/**
 * Extracts per-indicator signal directions from a technical analysis result
 * (`indicatorResults[].signals[]`). Returns a flat list of {trend, strength}.
 */
export function safeAnalysisIndicators(
    result: unknown,
): Array<{ trend?: string; strength?: string }> {
    const r = safeRecord(result);
    if (!r) return [];
    const indicators = safeArray(r, 'indicatorResults');
    if (!indicators) return [];
    const out: Array<{ trend?: string; strength?: string }> = [];
    for (const ind of indicators) {
        const signals = safeArray(ind, 'signals');
        if (!signals) continue;
        for (const sig of signals) {
            const s = safeRecord(sig);
            if (!s) continue;
            out.push({ trend: safeString(s.trend), strength: safeString(s.strength) });
        }
    }
    return out;
}

/**
 * Extracts per-category sentiments from a fundamental analysis result
 * (`categoryAssessments[]`). Returns a flat list of {sentiment}.
 */
export function safeFundamentalCategories(result: unknown): Array<{ sentiment?: string }> {
    const r = safeRecord(result);
    if (!r) return [];
    const cats = safeArray(r, 'categoryAssessments');
    if (!cats) return [];
    const out: Array<{ sentiment?: string }> = [];
    for (const c of cats) {
        const rec = safeRecord(c);
        if (!rec) continue;
        out.push({ sentiment: safeString(rec.sentiment) });
    }
    return out;
}

export function safeActionRecommendation(
    obj: unknown,
): { entryRecommendation: 'enter' | 'wait' | 'avoid' } | undefined {
    const r = safeRecord(obj);
    if (!r) return undefined;
    const rec = safeRecord(r.actionRecommendation);
    if (!rec) return undefined;
    // siglens-core's ActionRecommendation carries `entryRecommendation` ('enter' | 'wait' | 'avoid'); no confidence field.
    const entryRecommendation = safeString(rec.entryRecommendation);
    if (
        entryRecommendation !== 'enter' &&
        entryRecommendation !== 'wait' &&
        entryRecommendation !== 'avoid'
    ) {
        return undefined;
    }
    return { entryRecommendation };
}
