import { fmpGet } from './fmp-http.js';

interface FmpQuote {
    price: number;
    symbol: string;
    previousClose?: number;
}

export interface LivePriceDetail {
    source: 'fmp_quote';
    price: number | null;
    /**
     * 전일 종가. 일일 손실 차단기가 보유 포지션의 **오늘 변동분**을 재는 기준가다
     * (`lib/strategy/daily-loss.ts`). 값이 없거나 비정상이면 null — 호출자가 진입가로 대체한다.
     * 가격 조회 자체가 실패한 응답에는 없다.
     */
    previousClose?: number | null;
    reason?: 'empty_response' | 'malformed_response' | 'invalid_price' | 'request_failed';
    error?: string;
}

function unavailable(
    symbol: string,
    reason: NonNullable<LivePriceDetail['reason']>,
    error: string,
    log: boolean,
): LivePriceDetail {
    const detail: LivePriceDetail = { source: 'fmp_quote', price: null, reason, error };
    if (log) {
        console.warn('[live-price] price unavailable', { symbol, ...detail });
    }
    return detail;
}

/**
 * Fetches the current market price for a symbol from FMP's quote endpoint.
 * Returns null if the price is unavailable, invalid, or the request fails.
 */
export async function fetchLivePrice(symbol: string): Promise<number | null> {
    return (await fetchLivePriceDetail(symbol, { log: false })).price;
}

/**
 * Fetches the current market price and preserves the reason when it cannot be used.
 * Cron callers use this diagnostic payload in audit decisions.
 */
export async function fetchLivePriceDetail(
    symbol: string,
    options: { log?: boolean } = {},
): Promise<LivePriceDetail> {
    const log = options.log ?? true;
    try {
        const data = await fmpGet<FmpQuote[]>('quote', { symbol });
        if (!Array.isArray(data)) {
            return unavailable(
                symbol,
                'malformed_response',
                'FMP quote response was not an array',
                log,
            );
        }
        const quote = data[0];
        if (!quote) {
            return unavailable(symbol, 'empty_response', 'FMP quote response was empty', log);
        }
        // 응답이 요청한 심볼인지 확인한다. 이 가격은 손절 판정가·dry_run 체결가로 쓰이므로,
        // 매핑이 어긋나면 A의 가격으로 B를 손절한다.
        if (
            typeof quote.symbol === 'string' &&
            quote.symbol.toUpperCase() !== symbol.toUpperCase()
        ) {
            return unavailable(
                symbol,
                'malformed_response',
                `FMP quote returned a different symbol: ${quote.symbol}`,
                log,
            );
        }
        if (typeof quote.price !== 'number' || !Number.isFinite(quote.price) || quote.price <= 0) {
            return unavailable(
                symbol,
                'invalid_price',
                `FMP quote returned invalid price: ${String(quote.price)}`,
                log,
            );
        }
        const previousClose =
            typeof quote.previousClose === 'number' &&
            Number.isFinite(quote.previousClose) &&
            quote.previousClose > 0
                ? quote.previousClose
                : null;
        return { source: 'fmp_quote', price: quote.price, previousClose };
    } catch (err) {
        return unavailable(
            symbol,
            'request_failed',
            err instanceof Error ? err.message : String(err),
            log,
        );
    }
}
