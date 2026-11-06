import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetDb = vi.fn();
vi.mock('../../_lib/db', () => ({ getDb: () => mockGetDb() }));

const mockIsAuthenticated = vi.fn();
vi.mock('../../_lib/auth', () => ({ isAuthenticated: () => mockIsAuthenticated() }));

const q = {
    getConfigValue: vi.fn(),
    getPendingSubmittedOrders: vi.fn(),
    getNeedsReviewSymbols: vi.fn(),
    getOpenPositions: vi.fn(),
    getBotManagedSymbols: vi.fn(),
    startCronRun: vi.fn(),
    finishCronRun: vi.fn(),
};
vi.mock('../../../lib/db/queries', () => ({
    getConfigValue: (...a: unknown[]) => q.getConfigValue(...a),
    getPendingSubmittedOrders: (...a: unknown[]) => q.getPendingSubmittedOrders(...a),
    getNeedsReviewSymbols: (...a: unknown[]) => q.getNeedsReviewSymbols(...a),
    getOpenPositions: (...a: unknown[]) => q.getOpenPositions(...a),
    getBotManagedSymbols: (...a: unknown[]) => q.getBotManagedSymbols(...a),
    startCronRun: (...a: unknown[]) => q.startCronRun(...a),
    finishCronRun: (...a: unknown[]) => q.finishCronRun(...a),
}));

const mockApply = vi.fn();
vi.mock('../../../lib/db/holdings-sync', async (orig) => {
    const real = await orig<typeof import('../../../lib/db/holdings-sync')>();
    return { ...real, applyHoldingsSync: (...a: unknown[]) => mockApply(...a) };
});

const mockGetHoldings = vi.fn();
vi.mock('../../../lib/trading/account', () => ({ getHoldings: () => mockGetHoldings() }));

const mockAcquire = vi.fn();
const mockRelease = vi.fn();
vi.mock('../../../lib/lock', () => ({
    acquireLockDetailed: (...a: unknown[]) => mockAcquire(...a),
    releaseLock: (...a: unknown[]) => mockRelease(...a),
}));

import { GET, POST } from '../sync';
import { HoldingsSyncConflictError } from '../../../lib/db/holdings-sync';

const db = { fake: 'db' };
const holding = (symbol: string, quantity: number, avgPrice: number) => ({
    symbol,
    quantity,
    avgPrice,
    currentPrice: avgPrice,
    pnl: 0,
    currency: 'USD',
    marketCountry: 'US',
});

function req(method: string, body?: unknown): Request {
    return new Request('http://localhost/api/positions/sync', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function previewHash(): Promise<string> {
    const res = await GET(req('GET'));
    return ((await res.json()) as { hash: string }).hash;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue(db);
    mockIsAuthenticated.mockResolvedValue(true);
    q.getConfigValue.mockResolvedValue('auto');
    q.getPendingSubmittedOrders.mockResolvedValue([]);
    q.getNeedsReviewSymbols.mockResolvedValue([]);
    q.getOpenPositions.mockResolvedValue([
        { id: 1, symbol: 'AAPL', quantity: 5, avgPrice: '189.50' },
    ]);
    q.getBotManagedSymbols.mockResolvedValue(new Set(['AAPL', 'AMD']));
    q.startCronRun.mockResolvedValue(undefined);
    q.finishCronRun.mockResolvedValue(undefined);
    mockGetHoldings.mockResolvedValue([holding('AAPL', 6, 188), holding('QQQM', 10, 200)]);
    mockAcquire.mockResolvedValue({ token: 't' });
    mockRelease.mockResolvedValue(undefined);
    mockApply.mockResolvedValue({ applied: 1 });
});

describe('GET /api/positions/sync', () => {
    it('403 when not authenticated', async () => {
        mockIsAuthenticated.mockResolvedValue(false);
        expect((await GET(req('GET'))).status).toBe(403);
    });

    it('405 on other methods', async () => {
        expect((await GET(req('DELETE'))).status).toBe(405);
    });

    it('returns the diff and a hash, ignoring unmanaged holdings', async () => {
        const res = await GET(req('GET'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.blockedBy).toBeNull();
        expect(body.items).toHaveLength(1);
        expect(body.items[0]).toMatchObject({ action: 'update', symbol: 'AAPL' });
        expect(typeof body.hash).toBe('string');
    });

    it('does not call the broker in dry_run', async () => {
        q.getConfigValue.mockResolvedValue(null);
        const body = await (await GET(req('GET'))).json();
        expect(body).toMatchObject({
            mode: 'dry_run',
            blockedBy: 'dry_run',
            items: [],
            hash: null,
        });
        expect(mockGetHoldings).not.toHaveBeenCalled();
    });

    it('reports in-flight and needs_review symbols as blocking', async () => {
        q.getPendingSubmittedOrders.mockResolvedValue([{ symbol: 'NVDA' }, { symbol: 'AMD' }]);
        q.getNeedsReviewSymbols.mockResolvedValue(['AMD', 'ARM']);
        const body = await (await GET(req('GET'))).json();
        expect(body.blockedBy).toBe('orders_in_flight');
        expect(body.blockingSymbols).toEqual(['AMD', 'ARM', 'NVDA']);
        expect(body.items).toHaveLength(1);
    });

    it('502 when broker holdings are unavailable', async () => {
        mockGetHoldings.mockRejectedValue(new Error('403 access_denied'));
        const res = await GET(req('GET'));
        expect(res.status).toBe(502);
        expect((await res.json()).error).toContain('403 access_denied');
    });

    it('502 with a non-Error rejection', async () => {
        mockGetHoldings.mockRejectedValue('down');
        expect((await GET(req('GET'))).status).toBe(502);
    });
});

describe('POST /api/positions/sync', () => {
    it('400 without a hash', async () => {
        expect((await POST(req('POST', {}))).status).toBe(400);
        expect(mockAcquire).not.toHaveBeenCalled();
    });

    it('400 with an unparseable body', async () => {
        const r = new Request('http://localhost/api/positions/sync', { method: 'POST', body: 'x' });
        expect((await POST(r)).status).toBe(400);
    });

    it('applies when the hash matches and writes an audit row', async () => {
        const hash = await previewHash();
        const res = await POST(req('POST', { hash }));
        expect(res.status).toBe(200);
        expect((await res.json()).applied).toBe(1);
        expect(mockApply).toHaveBeenCalledWith(db, [expect.objectContaining({ symbol: 'AAPL' })]);
        expect(q.startCronRun).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ cronType: 'holdings_sync' }),
        );
        expect(q.finishCronRun).toHaveBeenCalledWith(
            db,
            expect.stringMatching(/^holdings_sync-/),
            expect.objectContaining({
                status: 'completed',
                summary: expect.objectContaining({ applied: 1 }),
            }),
        );
        expect(mockRelease).toHaveBeenCalledTimes(2);
    });

    it('409 when the broker changed after the preview', async () => {
        const hash = await previewHash();
        mockGetHoldings.mockResolvedValue([holding('AAPL', 7, 188)]);
        const res = await POST(req('POST', { hash }));
        expect(res.status).toBe(409);
        expect(mockApply).not.toHaveBeenCalled();
    });

    it('returns applied 0 without an audit row when already in sync', async () => {
        mockGetHoldings.mockResolvedValue([holding('AAPL', 5, 189.5)]);
        const hash = await previewHash();
        const body = await (await POST(req('POST', { hash }))).json();
        expect(body.applied).toBe(0);
        expect(q.startCronRun).not.toHaveBeenCalled();
    });

    it('409 when the execute lock is held', async () => {
        mockAcquire.mockResolvedValueOnce({ token: null, reason: 'contended' });
        expect((await POST(req('POST', { hash: 'x' }))).status).toBe(409);
        expect(mockRelease).not.toHaveBeenCalled();
    });

    it('409 when the reconcile lock is held, releasing the execute lock', async () => {
        mockAcquire
            .mockResolvedValueOnce({ token: 'e' })
            .mockResolvedValueOnce({ token: null, reason: 'contended' });
        expect((await POST(req('POST', { hash: 'x' }))).status).toBe(409);
        expect(mockRelease).toHaveBeenCalledWith('cron:execute:lock', 'e');
    });

    it('409 in dry_run', async () => {
        q.getConfigValue.mockResolvedValue('dry_run');
        const res = await POST(req('POST', { hash: 'x' }));
        expect(res.status).toBe(409);
        expect((await res.json()).blockedBy).toBe('dry_run');
    });

    it('409 with orders in flight, read after taking the locks', async () => {
        const hash = await previewHash();
        q.getPendingSubmittedOrders.mockResolvedValue([{ symbol: 'AAPL' }]);
        const res = await POST(req('POST', { hash }));
        expect(res.status).toBe(409);
        expect((await res.json()).error).toContain('AAPL');
        expect(mockApply).not.toHaveBeenCalled();
        expect(mockRelease).toHaveBeenCalledTimes(2);
    });

    it('502 when the broker fails on apply', async () => {
        const hash = await previewHash();
        mockGetHoldings.mockRejectedValue(new Error('timeout'));
        expect((await POST(req('POST', { hash }))).status).toBe(502);
    });

    it('409 and an error audit row on a ledger conflict', async () => {
        const hash = await previewHash();
        mockApply.mockRejectedValue(new HoldingsSyncConflictError('AAPL'));
        const res = await POST(req('POST', { hash }));
        expect(res.status).toBe(409);
        expect(q.finishCronRun).toHaveBeenCalledWith(
            db,
            expect.any(String),
            expect.objectContaining({ status: 'error' }),
        );
    });

    it('rethrows unexpected apply errors after recording them, still releasing locks', async () => {
        const hash = await previewHash();
        mockApply.mockRejectedValue(new Error('db down'));
        q.finishCronRun.mockRejectedValue(new Error('audit down'));
        await expect(POST(req('POST', { hash }))).rejects.toThrow('db down');
        expect(mockRelease).toHaveBeenCalledTimes(2);
    });

    it('records a non-Error apply failure', async () => {
        const hash = await previewHash();
        mockApply.mockRejectedValue('weird');
        await expect(POST(req('POST', { hash }))).rejects.toBe('weird');
        expect(q.finishCronRun).toHaveBeenCalledWith(
            db,
            expect.any(String),
            expect.objectContaining({ error: 'weird' }),
        );
    });
});
