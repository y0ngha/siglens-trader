import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetDb = vi.fn();
vi.mock('../../_lib/db', () => ({
    getDb: () => mockGetDb(),
}));

vi.mock('../../_lib/auth', () => ({
    isAuthenticated: () => true,
}));

const mockClosePosition = vi.fn();
const mockGetOpenPositions = vi.fn();
const mockInsertTrade = vi.fn();
vi.mock('../../../lib/db/queries', () => ({
    closePosition: (...args: unknown[]) => mockClosePosition(...args),
    getOpenPositions: (...args: unknown[]) => mockGetOpenPositions(...args),
    insertTrade: (...args: unknown[]) => mockInsertTrade(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeDb = {
    fake: 'db',
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakeDb),
};

function makeRequest(url: string, method = 'POST', body?: unknown): Request {
    const init: RequestInit = { method };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { 'Content-Type': 'application/json' };
    }
    return new Request(url, init);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.resetAllMocks();
    mockGetDb.mockReturnValue(fakeDb);
});

describe('POST /api/positions/[id]/close', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../[id]/close')).POST;
    });

    it('rejects non-POST methods', async () => {
        const res = await handler(makeRequest('https://example.com/api/positions/1/close', 'GET'));
        expect(res.status).toBe(405);
    });

    it('returns 400 for invalid ID', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/positions/abc/close', 'POST'),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Invalid position ID');
    });

    it('returns 404 when position not found', async () => {
        mockGetOpenPositions.mockResolvedValue([]);

        const res = await handler(
            makeRequest('https://example.com/api/positions/999/close', 'POST'),
        );
        expect(res.status).toBe(404);
        const data = await res.json();
        expect(data.error).toBe('Position not found');
    });

    it('closes position and inserts trade record', async () => {
        mockGetOpenPositions.mockResolvedValue([
            { id: 5, symbol: 'AAPL', quantity: 10, avgPrice: '150.50', status: 'open' },
        ]);
        mockClosePosition.mockResolvedValue(true);
        mockInsertTrade.mockResolvedValue([{}]);

        const res = await handler(makeRequest('https://example.com/api/positions/5/close', 'POST'));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toEqual({ success: true });

        expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 5, 150.5);
        expect(mockInsertTrade).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({
                symbol: 'AAPL',
                side: 'sell',
                orderType: 'market',
                quantity: 10,
                price: 150.5,
                reason: '수동 청산',
                mode: 'semi_auto',
            }),
        );
    });

    it('only closes the matching position by ID', async () => {
        mockGetOpenPositions.mockResolvedValue([
            { id: 1, symbol: 'AAPL', quantity: 5, avgPrice: '100', status: 'open' },
            { id: 2, symbol: 'TSLA', quantity: 3, avgPrice: '200', status: 'open' },
        ]);
        mockClosePosition.mockResolvedValue(true);
        mockInsertTrade.mockResolvedValue([{}]);

        const res = await handler(makeRequest('https://example.com/api/positions/2/close', 'POST'));
        expect(res.status).toBe(200);

        expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 2, 200);
        expect(mockInsertTrade).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ symbol: 'TSLA', quantity: 3 }),
        );
    });

    it('uses provided price from request body when valid', async () => {
        mockGetOpenPositions.mockResolvedValue([
            { id: 5, symbol: 'AAPL', quantity: 10, avgPrice: '150.50', status: 'open' },
        ]);
        mockClosePosition.mockResolvedValue(true);
        mockInsertTrade.mockResolvedValue([{}]);

        const res = await handler(
            makeRequest('https://example.com/api/positions/5/close', 'POST', { price: 155.25 }),
        );
        expect(res.status).toBe(200);

        expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 5, 155.25);
        expect(mockInsertTrade).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({
                price: 155.25,
                // realized PnL on manual close: (closePrice 155.25 − avgPrice 150.5) × 10
                realizedPnl: 47.5,
            }),
        );
    });

    it('falls back to avgPrice when price in body is invalid', async () => {
        mockGetOpenPositions.mockResolvedValue([
            { id: 5, symbol: 'AAPL', quantity: 10, avgPrice: '150.50', status: 'open' },
        ]);
        mockClosePosition.mockResolvedValue(true);
        mockInsertTrade.mockResolvedValue([{}]);

        const res = await handler(
            makeRequest('https://example.com/api/positions/5/close', 'POST', { price: -10 }),
        );
        expect(res.status).toBe(200);

        expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 5, 150.5);
    });

    it('falls back to avgPrice when body has no price field', async () => {
        mockGetOpenPositions.mockResolvedValue([
            { id: 5, symbol: 'AAPL', quantity: 10, avgPrice: '150.50', status: 'open' },
        ]);
        mockClosePosition.mockResolvedValue(true);
        mockInsertTrade.mockResolvedValue([{}]);

        const res = await handler(
            makeRequest('https://example.com/api/positions/5/close', 'POST', {}),
        );
        expect(res.status).toBe(200);

        expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 5, 150.5);
    });

    it('falls back to avgPrice when body is not valid JSON', async () => {
        mockGetOpenPositions.mockResolvedValue([
            { id: 5, symbol: 'AAPL', quantity: 10, avgPrice: '150.50', status: 'open' },
        ]);
        mockClosePosition.mockResolvedValue(true);
        mockInsertTrade.mockResolvedValue([{}]);

        // Send request with no body at all
        const res = await handler(makeRequest('https://example.com/api/positions/5/close', 'POST'));
        expect(res.status).toBe(200);

        expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 5, 150.5);
    });
});
