import { fmpGet } from './fmp-http.js';

interface FmpQuote {
    price: number;
    symbol: string;
}

/**
 * Fetches the current market price for a symbol from FMP's quote endpoint.
 * Returns null if the price is unavailable, invalid, or the request fails.
 */
export async function fetchLivePrice(symbol: string): Promise<number | null> {
    try {
        const data = await fmpGet<FmpQuote[]>('quote', { symbol });
        const quote = data[0];
        if (
            !quote ||
            typeof quote.price !== 'number' ||
            !Number.isFinite(quote.price) ||
            quote.price <= 0
        ) {
            return null;
        }
        return quote.price;
    } catch {
        return null;
    }
}
