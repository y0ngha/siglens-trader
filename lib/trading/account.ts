import { tossFetch } from './client.js';
import { parseDecimal } from '../validation.js';
import type { TossHolding } from './types.js';

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

/**
 * 매도 가능 수량. **읽을 수 없으면 `null`이다 — 0이 아니다.**
 *
 * 이전에는 파싱 실패가 `0`으로 떨어졌는데, 호출부는 0을 "팔 수 있는 주식이 없다"로 읽어
 * 청산을 조용히 건너뛴다(이메일도 없다). 브로커가 200에 필드명을 바꾸거나 `null`을 주는
 * 것만으로 손절이 무기한 막히는 경로였다. `null`은 호출부에서 "가드 비활성"으로 처리되어
 * 게이트가 정한 수량이 그대로 나간다 — 청산 fail-open 원칙과 같은 방향이다.
 *
 * 브로커가 명시적으로 `"0"`을 주는 것은 정상 값이므로 그대로 0을 반환한다.
 */
export async function getSellableQuantity(symbol: string): Promise<number | null> {
    const res = await tossFetch<{ sellableQuantity?: string }>('GET', '/api/v1/sellable-quantity', {
        account: true,
        query: { symbol },
    });
    if (res.sellableQuantity == null) return null;
    const parsed = parseDecimal(res.sellableQuantity, NaN);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
