import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTossFetch = vi.fn();
vi.mock('../client', () => ({
    tossFetch: (...args: unknown[]) => mockTossFetch(...args),
    TossApiError: class extends Error {},
}));

describe('account', () => {
    beforeEach(() => {
        vi.resetModules();
        mockTossFetch.mockReset();
    });

    it('getHoldings: HoldingsItem을 number로 정규화', async () => {
        mockTossFetch.mockResolvedValueOnce({
            items: [
                {
                    symbol: 'IONQ',
                    name: '아이온큐',
                    marketCountry: 'US',
                    currency: 'USD',
                    quantity: '0.013315',
                    lastPrice: '59.07',
                    averagePurchasePrice: '43.404581',
                    profitLoss: { amount: '0.208585' },
                },
            ],
        });
        const { getHoldings } = await import('../account');
        const holdings = await getHoldings();
        expect(holdings).toEqual([
            {
                symbol: 'IONQ',
                quantity: 0.013315,
                avgPrice: 43.404581,
                currentPrice: 59.07,
                pnl: 0.208585,
                marketCountry: 'US',
                currency: 'USD',
            },
        ]);
        expect(mockTossFetch).toHaveBeenCalledWith('GET', '/api/v1/holdings', { account: true });
    });

    it('getHoldings: 빈 보유 시 빈 배열', async () => {
        mockTossFetch.mockResolvedValueOnce({ items: [] });
        const { getHoldings } = await import('../account');
        expect(await getHoldings()).toEqual([]);
    });

    it('worst: getHoldings items 누락 시 빈 배열', async () => {
        mockTossFetch.mockResolvedValueOnce({});
        const { getHoldings } = await import('../account');
        expect(await getHoldings()).toEqual([]);
    });

    it('worst: getHoldings profitLoss 누락 시 pnl 0', async () => {
        mockTossFetch.mockResolvedValueOnce({
            items: [
                {
                    symbol: 'AAPL',
                    name: 'A',
                    marketCountry: 'US',
                    currency: 'USD',
                    quantity: '1',
                    lastPrice: '2',
                    averagePurchasePrice: '1',
                },
            ],
        });
        const { getHoldings } = await import('../account');
        const h = await getHoldings();
        expect(h[0].pnl).toBe(0);
    });

    it('getBuyingPower: USD 매수가능액 number 반환', async () => {
        mockTossFetch.mockResolvedValueOnce({ currency: 'USD', cashBuyingPower: '1131.38' });
        const { getBuyingPower } = await import('../account');
        expect(await getBuyingPower('USD')).toBe(1131.38);
        expect(mockTossFetch).toHaveBeenCalledWith('GET', '/api/v1/buying-power', {
            account: true,
            query: { currency: 'USD' },
        });
    });

    it('worst: getBuyingPower 값이 비정상이면 0', async () => {
        mockTossFetch.mockResolvedValueOnce({ currency: 'USD', cashBuyingPower: 'abc' });
        const { getBuyingPower } = await import('../account');
        expect(await getBuyingPower('USD')).toBe(0);
    });

    it('getSellableQuantity: number 반환', async () => {
        mockTossFetch.mockResolvedValueOnce({ sellableQuantity: '100' });
        const { getSellableQuantity } = await import('../account');
        expect(await getSellableQuantity('AAPL')).toBe(100);
        expect(mockTossFetch).toHaveBeenCalledWith('GET', '/api/v1/sellable-quantity', {
            account: true,
            query: { symbol: 'AAPL' },
        });
    });

    it('worst: getSellableQuantity 값 누락 시 0', async () => {
        mockTossFetch.mockResolvedValueOnce({});
        const { getSellableQuantity } = await import('../account');
        expect(await getSellableQuantity('AAPL')).toBe(0);
    });

    it('cancelOrder: POST cancel 경로 호출', async () => {
        mockTossFetch.mockResolvedValueOnce({ orderId: 'o1' });
        const { cancelOrder } = await import('../account');
        await cancelOrder('o1');
        expect(mockTossFetch).toHaveBeenCalledWith('POST', '/api/v1/orders/o1/cancel', {
            account: true,
        });
    });

    it('worst: cancelOrder 에러 전파', async () => {
        mockTossFetch.mockRejectedValueOnce(new Error('cancel failed'));
        const { cancelOrder } = await import('../account');
        await expect(cancelOrder('o1')).rejects.toThrow('cancel failed');
    });

    it('isUsMarketOpen: 정규장 세션 있으면 true', async () => {
        mockTossFetch.mockResolvedValueOnce({
            today: { date: '2026-06-11', regularMarket: { start: 'x' } },
        });
        const { isUsMarketOpen } = await import('../account');
        expect(await isUsMarketOpen()).toBe(true);
        expect(mockTossFetch).toHaveBeenCalledWith('GET', '/api/v1/market-calendar/US', {});
    });

    it('worst: 휴장(regularMarket null)이면 false', async () => {
        mockTossFetch.mockResolvedValueOnce({ today: { date: '2026-06-11', regularMarket: null } });
        const { isUsMarketOpen } = await import('../account');
        expect(await isUsMarketOpen()).toBe(false);
    });

    it('worst: today 누락 시 false (보수적)', async () => {
        mockTossFetch.mockResolvedValueOnce({});
        const { isUsMarketOpen } = await import('../account');
        expect(await isUsMarketOpen()).toBe(false);
    });
});
