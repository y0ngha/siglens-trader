import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../_lib/auth', () => ({
    isAuthenticated: () => Promise.resolve(true),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/analysis/trigger', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        vi.resetAllMocks();
        handler = (await import('../trigger')).POST;
    });

    it('rejects non-POST methods', async () => {
        const req = new Request('https://example.com/api/analysis/trigger', { method: 'GET' });
        const res = await handler(req);
        expect(res.status).toBe(405);
    });

    it('returns 400 for invalid JSON', async () => {
        const req = new Request('https://example.com/api/analysis/trigger', {
            method: 'POST',
            body: 'not json',
        });
        const res = await handler(req);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Invalid JSON');
    });

    it('returns 400 when symbol is missing', async () => {
        const req = new Request('https://example.com/api/analysis/trigger', {
            method: 'POST',
            body: JSON.stringify({}),
            headers: { 'Content-Type': 'application/json' },
        });
        const res = await handler(req);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Missing symbol');
    });

    it('returns 400 when symbol is not a string', async () => {
        const req = new Request('https://example.com/api/analysis/trigger', {
            method: 'POST',
            body: JSON.stringify({ symbol: 123 }),
            headers: { 'Content-Type': 'application/json' },
        });
        const res = await handler(req);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Missing symbol');
    });

    it('returns success for valid symbol', async () => {
        const req = new Request('https://example.com/api/analysis/trigger', {
            method: 'POST',
            body: JSON.stringify({ symbol: 'AAPL' }),
            headers: { 'Content-Type': 'application/json' },
        });
        const res = await handler(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toEqual({ success: true, message: 'Analysis triggered for AAPL' });
    });
});
