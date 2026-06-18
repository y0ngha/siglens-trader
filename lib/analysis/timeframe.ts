import type { Timeframe } from '@y0ngha/siglens-core';

export const ANALYSIS_TIMEFRAMES = ['15Min', '30Min', '1Hour'] as const;
export type AnalysisTimeframe = (typeof ANALYSIS_TIMEFRAMES)[number];
export const DEFAULT_ANALYSIS_TIMEFRAME: AnalysisTimeframe = '1Hour';

export function isAnalysisTimeframe(value: unknown): value is AnalysisTimeframe {
    return typeof value === 'string' && (ANALYSIS_TIMEFRAMES as readonly string[]).includes(value);
}

export function normalizeAnalysisTimeframe(value: unknown): AnalysisTimeframe {
    return isAnalysisTimeframe(value) ? value : DEFAULT_ANALYSIS_TIMEFRAME;
}

export function toCoreTimeframe(value: unknown): Timeframe {
    return normalizeAnalysisTimeframe(value);
}

const MAX_AGE_MS: Record<AnalysisTimeframe, number> = {
    '15Min': 45 * 60_000,
    '30Min': 90 * 60_000,
    '1Hour': 2 * 60 * 60_000,
};

export function getTechnicalMaxAgeMs(timeframe: AnalysisTimeframe): number {
    return MAX_AGE_MS[timeframe];
}
