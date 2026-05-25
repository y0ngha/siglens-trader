import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';

const mockFetch = vi.fn();

beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
    vi.restoreAllMocks();
});

function mockOk(data: unknown) {
    mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(data),
        text: () => Promise.resolve(JSON.stringify(data)),
    });
}

function mockError(status: number, body = 'error') {
    mockFetch.mockResolvedValueOnce({
        ok: false,
        status,
        text: () => Promise.resolve(body),
    });
}

describe('api', () => {
    describe('getStatus', () => {
        it('returns status response on success', async () => {
            const data = {
                running: true,
                tradingMode: 'DRY_RUN',
                activePositions: 2,
                todayTrades: 5,
            };
            mockOk(data);

            const result = await api.getStatus();

            expect(result).toEqual(data);
            expect(mockFetch).toHaveBeenCalledWith(
                '/api/status',
                expect.objectContaining({
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
        });

        it('throws on error response', async () => {
            mockError(500, 'Internal Server Error');

            await expect(api.getStatus()).rejects.toThrow('API 500: Internal Server Error');
        });
    });

    describe('getPositions', () => {
        it('returns positions array on success', async () => {
            const data = [
                {
                    id: 1,
                    symbol: 'AAPL',
                    side: 'long',
                    quantity: 10,
                    avgPrice: '150.00',
                    openedAt: '2025-01-01',
                    status: 'open',
                },
            ];
            mockOk(data);

            const result = await api.getPositions();

            expect(result).toEqual(data);
            expect(mockFetch).toHaveBeenCalledWith('/api/positions', expect.anything());
        });
    });

    describe('getTrades', () => {
        it('returns trades array on success', async () => {
            const data = [
                {
                    id: 1,
                    symbol: 'TSLA',
                    side: 'buy',
                    orderType: 'market',
                    quantity: 5,
                    price: '200.00',
                    executedAt: '2025-01-01',
                    reason: null,
                    mode: 'DRY_RUN',
                },
            ];
            mockOk(data);

            const result = await api.getTrades();

            expect(result).toEqual(data);
            expect(mockFetch).toHaveBeenCalledWith('/api/trades', expect.anything());
        });
    });

    describe('getAnalysis', () => {
        it('fetches with symbol param when provided', async () => {
            mockOk([{ id: 1 }]);

            await api.getAnalysis('AAPL');

            expect(mockFetch).toHaveBeenCalledWith('/api/analysis?symbol=AAPL', expect.anything());
        });

        it('fetches without symbol param when not provided', async () => {
            mockOk([]);

            await api.getAnalysis();

            expect(mockFetch).toHaveBeenCalledWith('/api/analysis', expect.anything());
        });
    });

    describe('getConfig', () => {
        it('returns config on success', async () => {
            const data = { tradingMode: 'AUTO', watchlist: [] };
            mockOk(data);

            const result = await api.getConfig();

            expect(result).toEqual(data);
            expect(mockFetch).toHaveBeenCalledWith('/api/config', expect.anything());
        });
    });

    describe('updateConfig', () => {
        it('sends POST with JSON body', async () => {
            mockOk({ success: true });
            const body = { type: 'general', tradingMode: 'AUTO' };

            await api.updateConfig(body);

            expect(mockFetch).toHaveBeenCalledWith(
                '/api/config',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
        });
    });

    describe('getPending', () => {
        it('returns pending orders on success', async () => {
            const data = [
                {
                    id: 1,
                    symbol: 'AAPL',
                    side: 'buy',
                    quantity: 10,
                    priceLimit: null,
                    analysisSummary: null,
                    signalScore: null,
                    createdAt: '2025-01-01',
                    expiresAt: '2025-01-02',
                    status: 'pending',
                },
            ];
            mockOk(data);

            const result = await api.getPending();

            expect(result).toEqual(data);
            expect(mockFetch).toHaveBeenCalledWith('/api/pending', expect.anything());
        });
    });

    describe('approveOrder', () => {
        it('sends POST with approve action', async () => {
            mockOk({ success: true });

            await api.approveOrder(42);

            expect(mockFetch).toHaveBeenCalledWith(
                '/api/approve/42',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({ action: 'approve' }),
                }),
            );
        });
    });

    describe('rejectOrder', () => {
        it('sends POST with reject action', async () => {
            mockOk({ success: true });

            await api.rejectOrder(7);

            expect(mockFetch).toHaveBeenCalledWith(
                '/api/approve/7',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({ action: 'reject' }),
                }),
            );
        });
    });

    describe('dismissAlert', () => {
        it('sends POST with dismiss action and trade id', async () => {
            mockOk({ success: true });

            await api.dismissAlert(42);

            expect(mockFetch).toHaveBeenCalledWith(
                '/api/trades',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({ action: 'dismiss', id: 42 }),
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
        });
    });

    describe('error handling', () => {
        it('throws with status code for non-ok responses', async () => {
            mockError(403, 'Forbidden');

            await expect(api.getPositions()).rejects.toThrow('API 403: Forbidden');
        });

        it('throws with status code 404', async () => {
            mockError(404, 'Not Found');

            await expect(api.getConfig()).rejects.toThrow('API 404: Not Found');
        });
    });
});
