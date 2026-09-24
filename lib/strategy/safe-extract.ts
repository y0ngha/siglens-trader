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

export function safeAnalysisRiskLevel(result: unknown): string | undefined {
    const r = safeRecord(result);
    return r ? safeString(r.riskLevel) : undefined;
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
 * produced `undefined` in production, silently killing an exit rule of the old strategy.
 * The fix: go through `safePriceLevelArray`, which already accepts both the real
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
 * `actionRecommendation`에서 가격 세 개를 읽는다 — 권장 진입 구간, 손절가, 익절가.
 *
 * `safeActionRecommendation`은 `entryRecommendation` 하나만 돌려주고 그 값이 유효하지
 * 않으면 통째로 `undefined`가 되므로, 가격은 여기서 따로 읽는다.
 *
 * **`reconciledLevels`가 있으면 그쪽이 이긴다.** core는 AI가 낸 손절/익절이 유효하지 않을
 * 때(예: 손절가가 현재가 위) 원본을 그대로 두고 도메인 보정값을 `reconciledLevels`에 따로
 * 붙인다. 원본을 그대로 트리거로 쓰면 core가 "이 값은 못 쓴다"고 판정한 숫자로 청산하게
 * 되므로, 보정값이 있으면 그 자리를 대체한다.
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

/**
 * AI가 제시한 익절가 전체 사다리(보정값 우선) — 오름차순.
 *
 * `safeAnalysisTakeProfit`은 가장 가까운 한 칸만 반환한다(청산 트리거는 단일 숫자여야
 * 하므로). prior-analysis 이력(`lib/analysis/prior-analysis.ts`)은 트리거가 아니라 "그때
 * 무엇을 목표로 했는가"를 프롬프트에 참고 정보로 보여줄 뿐이라 사다리 전체가 필요하다.
 */
export function safeAnalysisTakeProfitLadder(result: unknown): number[] | undefined {
    const { rec, reconciled } = actionRecommendationRecords(result);
    const ladder =
        safePriceLevelArray(reconciled?.takeProfitPrices) ??
        safePriceLevelArray(rec?.takeProfitPrices);
    // 오름차순을 **가정하지 않고 강제한다.** core는 `takeProfitPrices[0]`을
    // "가장 가까운 목표가"로 보고 도달 여부를 채점하는데, 순서가 뒤집힌 채
    // 저장된 옛 행이 하나라도 있으면 가장 먼 목표를 최근접으로 오독해
    // "목표 미달"을 "달성"으로 뒤집어 보고하게 된다. 저장된 JSONB의 순서를
    // 신뢰할 이유가 없다 — 몇 달 전 프롬프트 세대가 쓴 값일 수 있다.
    return ladder === undefined ? undefined : [...ladder].sort((a, b) => a - b);
}

/** AI가 제시한 손절가 (보정값 우선). 과거 분석 맥락(`prior-analysis.ts`)이 읽는다. */
export function safeAnalysisStopLoss(result: unknown): number | undefined {
    const { rec, reconciled } = actionRecommendationRecords(result);
    for (const candidate of [reconciled?.stopLoss, rec?.stopLoss]) {
        if (isFinitePositive(candidate)) return candidate;
    }
    return undefined;
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
