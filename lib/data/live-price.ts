import { fmpGet } from './fmp-http.js';

interface FmpQuote {
    price: number;
    symbol: string;
}

export interface LivePriceDetail {
    source: 'fmp_quote';
    price: number | null;
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
        if (typeof quote.price !== 'number' || !Number.isFinite(quote.price) || quote.price <= 0) {
            return unavailable(
                symbol,
                'invalid_price',
                `FMP quote returned invalid price: ${String(quote.price)}`,
                log,
            );
        }
        return { source: 'fmp_quote', price: quote.price };
    } catch (err) {
        return unavailable(
            symbol,
            'request_failed',
            err instanceof Error ? err.message : String(err),
            log,
        );
    }
}
