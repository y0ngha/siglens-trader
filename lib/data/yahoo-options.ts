import type { OptionsSnapshot } from '@y0ngha/siglens-core';
import yahooFinance from 'yahoo-finance2';
import { normalizeYahooSnapshot, type YahooOptionsResult } from './yahoo-normalize.js';

// v3 default export는 YahooFinance 클래스. 모듈 로드 시 1회 인스턴스화하여 재사용한다.
const yf = new (yahooFinance as unknown as new () => {
    options: (
        symbol: string,
        queryOptions?: Record<string, unknown>,
        moduleOptions?: { fetchOptions?: { signal?: AbortSignal } },
    ) => Promise<unknown>;
})();

/**
 * 야후 응답 대기 상한. yahoo-finance2는 `fetchOptions.signal`을 주지 않으면 **무한 대기**다.
 * 연결만 받고 응답이 없으면 분석 cron의 `Promise.all`이 영영 풀리지 않아 락 해제도
 * 감사 행 마감도 없고, node-cron의 `noOverlap`이 이후 모든 options 틱을 프로세스
 * 재시작까지 막는다.
 */
const FETCH_TIMEOUT_MS = 10_000;

export async function fetchOptionsSnapshot(symbol: string): Promise<OptionsSnapshot | null> {
    try {
        const result = await yf.options(symbol, undefined, {
            fetchOptions: { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
        });
        return normalizeYahooSnapshot(result as unknown as YahooOptionsResult, new Date());
    } catch (err) {
        console.warn(`[yahoo-options] failed to fetch ${symbol}:`, err);
        return null;
    }
}
