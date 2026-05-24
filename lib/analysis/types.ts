import type { ModelId, Timeframe } from '@y0ngha/siglens-core';

export type AnalysisType = 'technical' | 'news' | 'options' | 'fundamental' | 'overall';

export interface RunAnalysisOptions {
    symbol: string;
    companyName: string;
    modelId: ModelId;
    userApiKey?: string;
    timeframe?: Timeframe;
}

export interface AnalysisRunResult {
    status: 'done' | 'cached' | 'error' | 'skipped';
    result?: unknown;
    error?: string;
}
