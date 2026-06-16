import type { ModelId, Timeframe } from '@y0ngha/siglens-core';
import type { Db } from '../db/index.js';

export type AnalysisType = 'technical' | 'news' | 'options' | 'fundamental' | 'overall';

export interface RunAnalysisOptions {
    symbol: string;
    companyName: string;
    modelId: ModelId;
    userApiKey?: string;
    timeframe?: Timeframe;
    /** news enrich에 필요. factory가 항상 주입. */
    db?: Db;
}

export interface AnalysisRunResult {
    status: 'done' | 'cached' | 'error' | 'skipped';
    result?: unknown;
    error?: string;
}
