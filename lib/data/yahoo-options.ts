import type { OptionsSnapshot } from '@y0ngha/siglens-core';
import yahooFinance from 'yahoo-finance2';
import { normalizeYahooSnapshot, type YahooOptionsResult } from './yahoo-normalize.js';

// v3 default export는 YahooFinance 클래스. 모듈 로드 시 1회 인스턴스화하여 재사용한다.
const yf = new (yahooFinance as unknown as new () => {
    options: (symbol: string) => Promise<unknown>;
})();

export async function fetchOptionsSnapshot(symbol: string): Promise<OptionsSnapshot | null> {
    try {
        const result = await yf.options(symbol);
        return normalizeYahooSnapshot(result as unknown as YahooOptionsResult, new Date());
    } catch (err) {
        console.warn(`[yahoo-options] failed to fetch ${symbol}:`, err);
        return null;
    }
}
