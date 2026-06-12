import type { OptionsSnapshot } from '@y0ngha/siglens-core';
import yahooFinance from 'yahoo-finance2';
import { normalizeYahooSnapshot, type YahooOptionsResult } from './yahoo-normalize.js';

export async function fetchOptionsSnapshot(symbol: string): Promise<OptionsSnapshot | null> {
    try {
        const result = await yahooFinance.options(symbol);
        return normalizeYahooSnapshot(result as unknown as YahooOptionsResult, new Date());
    } catch (err) {
        console.warn(`[yahoo-options] failed to fetch ${symbol}:`, err);
        return null;
    }
}
