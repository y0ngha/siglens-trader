import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFmpGet = vi.fn();
vi.mock('../fmp-http', () => ({
    fmpGet: (...args: unknown[]) => mockFmpGet(...args),
}));

import { fetchLivePrice } from '../live-price';

describe('fetchLivePrice', () => {
    beforeEach(() => {
        mockFmpGet.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns price from first quote on success', async () => {
        mockFmpGet.mockResolvedValue([{ symbol: 'AAPL', price: 185.5 }]);

        const result = await fetchLivePrice('AAPL');

        expect(result).toBe(185.5);
        expect(mockFmpGet).toHaveBeenCalledWith('quote', { symbol: 'AAPL' });
    });

    it('returns null when response array is empty', async () => {
        mockFmpGet.mockResolvedValue([]);

        const result = await fetchLivePrice('AAPL');

        expect(result).toBeNull();
    });

    it('returns null when price is not a number', async () => {
        mockFmpGet.mockResolvedValue([{ symbol: 'AAPL', price: 'N/A' }]);

        const result = await fetchLivePrice('AAPL');

        expect(result).toBeNull();
    });

    it('returns null when price is NaN', async () => {
        mockFmpGet.mockResolvedValue([{ symbol: 'AAPL', price: NaN }]);

        const result = await fetchLivePrice('AAPL');

        expect(result).toBeNull();
    });

    it('returns null when price is Infinity', async () => {
        mockFmpGet.mockResolvedValue([{ symbol: 'AAPL', price: Infinity }]);

        const result = await fetchLivePrice('AAPL');

        expect(result).toBeNull();
    });

    it('returns null when price is zero', async () => {
        mockFmpGet.mockResolvedValue([{ symbol: 'AAPL', price: 0 }]);

        const result = await fetchLivePrice('AAPL');

        expect(result).toBeNull();
    });

    it('returns null when price is negative', async () => {
        mockFmpGet.mockResolvedValue([{ symbol: 'AAPL', price: -10 }]);

        const result = await fetchLivePrice('AAPL');

        expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
        mockFmpGet.mockRejectedValue(new Error('FMP quote 500'));

        const result = await fetchLivePrice('AAPL');

        expect(result).toBeNull();
    });

    it('returns null when quote object is missing price field', async () => {
        mockFmpGet.mockResolvedValue([{ symbol: 'AAPL' }]);

        const result = await fetchLivePrice('AAPL');

        expect(result).toBeNull();
    });
});
