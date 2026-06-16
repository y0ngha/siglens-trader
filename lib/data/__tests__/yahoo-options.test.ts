import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockOptions = vi.fn();
const mockConstructor = vi.fn(() => ({ options: mockOptions }));
vi.mock('yahoo-finance2', () => ({
    default: mockConstructor,
}));

describe('fetchOptionsSnapshot', () => {
    beforeEach(() => {
        mockOptions.mockReset();
        mockConstructor.mockClear();
    });

    it('fetches and normalizes snapshot on success', async () => {
        const { fetchOptionsSnapshot } = await import('../yahoo-options');
        mockOptions.mockResolvedValueOnce({
            underlyingSymbol: 'AAPL',
            expirationDates: [],
            strikes: [],
            hasMiniOptions: false,
            quote: { regularMarketPrice: 195.0 },
            options: [
                {
                    expirationDate: new Date('2025-06-20T00:00:00.000Z'),
                    hasMiniOptions: false,
                    calls: [
                        {
                            contractSymbol: 'AAPL250620C00195000',
                            strike: 195,
                            lastPrice: 3.0,
                            change: 0.1,
                            volume: 500,
                            openInterest: 2000,
                            bid: 2.9,
                            ask: 3.1,
                            contractSize: 'REGULAR',
                            expiration: new Date('2025-06-20T00:00:00.000Z'),
                            lastTradeDate: new Date('2025-06-01T15:00:00.000Z'),
                            impliedVolatility: 0.28,
                            inTheMoney: true,
                        },
                    ],
                    puts: [],
                },
            ],
        });

        const result = await fetchOptionsSnapshot('AAPL');

        expect(result).not.toBeNull();
        expect(result!.symbol).toBe('AAPL');
        expect(result!.underlyingPrice).toBe(195.0);
        expect(result!.chains).toHaveLength(1);
        expect(result!.chains[0].calls).toHaveLength(1);
        expect(result!.chains[0].calls[0].strike).toBe(195);
    });

    it('returns null on fetch error', async () => {
        const { fetchOptionsSnapshot } = await import('../yahoo-options');
        mockOptions.mockRejectedValueOnce(new Error('Network error'));

        const result = await fetchOptionsSnapshot('INVALID');

        expect(result).toBeNull();
    });

    it('returns null when yahoo-finance2 throws', async () => {
        const { fetchOptionsSnapshot } = await import('../yahoo-options');
        mockOptions.mockRejectedValueOnce(new Error('Symbol not found'));

        const result = await fetchOptionsSnapshot('ZZZZZ');

        expect(result).toBeNull();
    });

    it('인스턴스는 모듈당 1회만 생성된다', async () => {
        vi.resetModules();
        mockConstructor.mockClear();
        const { fetchOptionsSnapshot } = await import('../yahoo-options');
        mockOptions.mockResolvedValue({
            underlyingSymbol: 'AAPL',
            expirationDates: [],
            strikes: [],
            hasMiniOptions: false,
            quote: { regularMarketPrice: 100 },
            options: [],
        });
        await fetchOptionsSnapshot('AAPL');
        await fetchOptionsSnapshot('AAPL');
        await fetchOptionsSnapshot('AAPL');
        expect(mockConstructor).toHaveBeenCalledTimes(1);
    });
});
