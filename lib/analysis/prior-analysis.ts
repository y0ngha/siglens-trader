import type { PriorAnalysis } from '@y0ngha/siglens-core';
import {
    safeAnalysisEntryPrices,
    safeAnalysisRiskLevel,
    safeAnalysisStopLoss,
    safeAnalysisTakeProfitLadder,
    safeAnalysisTrend,
} from '../strategy/safe-extract.js';
import type { PriorAnalysisRow } from './types.js';

/**
 * `trend` / `riskLevel`의 허용 값 집합.
 *
 * `safeAnalysisTrend` / `safeAnalysisRiskLevel`은 `typeof === 'string'`만 본다.
 * 그 검사만 통과시키고 캐스팅하면 유니온 밖 문자열 — 옛 프롬프트 세대가 남긴 값,
 * 오타, 이 파일이 스스로 경고하는 shape drift — 이 그대로 통과한다.
 *
 * 런타임에 터지지도 않는다. core의 렌더러가 그 값을 문자열 보간으로 그대로 실어
 * **"과거에 이렇게 판단했다"는 사실 진술로 프롬프트에 주입**한다. 모델이 자기
 * 과거 판단을 사실 대조하게 만드는 게 이 기능의 목적인데, 그 사실 자체가
 * 거짓이 되는 셈이다. 유니온 밖이면 그 행을 버린다.
 */
const TRENDS = ['bullish', 'bearish', 'neutral'] as const;
const RISK_LEVELS = ['low', 'medium', 'high'] as const;

function isTrend(value: string | undefined): value is PriorAnalysis['trend'] {
    return value !== undefined && (TRENDS as readonly string[]).includes(value);
}

function isRiskLevel(value: string | undefined): value is PriorAnalysis['riskLevel'] {
    return value !== undefined && (RISK_LEVELS as readonly string[]).includes(value);
}

/**
 * Maps stored `analysis_results.result` JSONB rows into siglens-core's `PriorAnalysis`
 * history entries, for the anti-anchoring context core renders into the technical prompt.
 *
 * **Validates defensively.** A row may have been written months ago by an older prompt
 * generation (`analysis_results.app_version` records which one, but this function does not
 * read it — the question here is "does this row still parse", not "which version wrote it").
 * A row whose `trend` or `riskLevel` is missing or not a string is skipped outright — those
 * are the two fields core actually compares against what price did afterwards, so a bad value
 * would silently mislabel the very past call this feature exists to fact-check the model
 * against. Numeric action-recommendation fields (`entryPrices` / `stopLoss` /
 * `takeProfitPrices`) are dropped individually via `safe-extract.ts`'s existing NaN/Infinity
 * guards rather than failing the whole row — a partial entry (trend known, no stop-loss) still
 * helps the guardrail more than discarding it would.
 *
 * **Deliberately does NOT filter by `model_id`.** It is recorded on `analysis_results` for
 * auditing — which model produced a row — not for deciding which rows count as history. A past
 * market call is a past market call regardless of which model produced it; filtering by model
 * would fragment the (already sparse, cadence-window-gated) history across every model swap or
 * BYOK change, leaving most symbols with an empty history right when it would otherwise start
 * being useful. Do not "fix" this by adding a model filter.
 */
export function mapRowsToPriorAnalyses(rows: readonly PriorAnalysisRow[]): PriorAnalysis[] {
    const out: PriorAnalysis[] = [];
    for (const row of rows) {
        const trend = safeAnalysisTrend(row.result);
        const riskLevel = safeAnalysisRiskLevel(row.result);
        if (!isTrend(trend) || !isRiskLevel(riskLevel)) continue;

        const entryPrices = safeAnalysisEntryPrices(row.result);
        const stopLoss = safeAnalysisStopLoss(row.result);
        const takeProfitPrices = safeAnalysisTakeProfitLadder(row.result);

        out.push({
            generatedAt: row.analyzedAt,
            trend,
            riskLevel,
            ...(entryPrices.length > 0 ? { entryPrices } : {}),
            ...(stopLoss !== undefined ? { stopLoss } : {}),
            ...(takeProfitPrices ? { takeProfitPrices } : {}),
        });
    }
    return out;
}
