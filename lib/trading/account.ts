import { tossFetch } from './client';
import { parseDecimal } from '../validation';
import type { TossHolding } from './types';

interface HoldingsItemRaw {
    symbol: string;
    name: string;
    marketCountry: string;
    currency: string;
    quantity: string;
    lastPrice: string;
    averagePurchasePrice: string;
    profitLoss?: { amount?: string };
}

export async function getHoldings(): Promise<TossHolding[]> {
    const overview = await tossFetch<{ items?: HoldingsItemRaw[] }>('GET', '/api/v1/holdings', {
        account: true,
    });
    const items = overview.items ?? [];
    return items.map((it) => ({
        symbol: it.symbol,
        quantity: parseDecimal(it.quantity, 0),
        avgPrice: parseDecimal(it.averagePurchasePrice, 0),
        currentPrice: parseDecimal(it.lastPrice, 0),
        pnl: parseDecimal(it.profitLoss?.amount, 0),
        marketCountry: it.marketCountry,
        currency: it.currency,
    }));
}

export async function getBuyingPower(currency: 'USD' | 'KRW'): Promise<number> {
    const res = await tossFetch<{ cashBuyingPower: string }>('GET', '/api/v1/buying-power', {
        account: true,
        query: { currency },
    });
    return parseDecimal(res.cashBuyingPower, 0);
}

export async function getSellableQuantity(symbol: string): Promise<number> {
    const res = await tossFetch<{ sellableQuantity?: string }>('GET', '/api/v1/sellable-quantity', {
        account: true,
        query: { symbol },
    });
    return parseDecimal(res.sellableQuantity, 0);
}

export async function cancelOrder(orderId: string): Promise<void> {
    await tossFetch('POST', `/api/v1/orders/${orderId}/cancel`, { account: true });
}

/**
 * 미국 정규장 영업일 여부.
 * 휴장이면 모든 세션이 null. 조회 실패/today 누락 시 보수적으로 false.
 */
export async function isUsMarketOpen(): Promise<boolean> {
    const cal = await tossFetch<{ today?: { regularMarket?: unknown | null } }>(
        'GET',
        '/api/v1/market-calendar/US',
        {},
    );
    return cal.today?.regularMarket != null;
}
