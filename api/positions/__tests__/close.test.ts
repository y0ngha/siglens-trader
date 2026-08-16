import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetDb = vi.fn();
vi.mock('../../_lib/db', () => ({
    getDb: () => mockGetDb(),
}));

vi.mock('../../_lib/auth', () => ({
    isAuthenticated: () => Promise.resolve(true),
}));

const mockClosePosition = vi.fn();
const mockGetOpenPositions = vi.fn();
const mockInsertTrade = vi.fn();
const mockGetConfigValue = vi.fn();
const mockCreateOrderTracking = vi.fn();
const mockUpdateOrderTracking = vi.fn();
vi.mock('../../../lib/db/queries', () => ({
    closePosition: (...args: unknown[]) => mockClosePosition(...args),
    getOpenPositions: (...args: unknown[]) => mockGetOpenPositions(...args),
    insertTrade: (...args: unknown[]) => mockInsertTrade(...args),
    getConfigValue: (...args: unknown[]) => mockGetConfigValue(...args),
    createOrderTracking: (...args: unknown[]) => mockCreateOrderTracking(...args),
    updateOrderTracking: (...args: unknown[]) => mockUpdateOrderTracking(...args),
}));

// `auto`에서는 이 엔드포인트가 브로커에 실제 매도 주문을 낸다.
const mockExecuteSellOrder = vi.fn();
vi.mock('../../../lib/trading/orders', () => ({
    executeSellOrder: (...args: unknown[]) => mockExecuteSellOrder(...args),
}));

const mockFetchLivePrice = vi.fn();
vi.mock('../../../lib/data/live-price', () => ({
    fetchLivePrice: (...args: unknown[]) => mockFetchLivePrice(...args),
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
    // 기본은 dry_run — 브로커를 건드리지 않는 기존 동작.
    mockGetConfigValue.mockResolvedValue('dry_run');
    // 호가는 기본적으로 없음 → avgPrice 폴백. 필요한 테스트가 개별로 덮는다.
    mockFetchLivePrice.mockResolvedValue(null);
    mockCreateOrderTracking.mockResolvedValue([]);
    mockUpdateOrderTracking.mockResolvedValue([]);
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
                // 하드코딩이 아니라 실제 모드를 기록한다 — dry_run 청산이 실계좌
                // 손실 차단기 입력에 섞이던 문제.
                mode: 'dry_run',
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

// ---------------------------------------------------------------------------
// auto 모드: 브로커 주문이 실제로 나가야 한다
// ---------------------------------------------------------------------------

describe('POST /api/positions/[id]/close — auto 모드', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../[id]/close')).POST;
        mockGetConfigValue.mockResolvedValue('auto');
        mockGetOpenPositions.mockResolvedValue([
            { id: 1, symbol: 'AAPL', quantity: 10, avgPrice: '100', status: 'open' },
        ]);
        mockClosePosition.mockResolvedValue(true);
        mockInsertTrade.mockResolvedValue([]);
        mockFetchLivePrice.mockResolvedValue(150);
    });

    it('브로커에 매도 주문을 내고 체결가로 기록한다', async () => {
        mockExecuteSellOrder.mockResolvedValue({
            orderId: 'ord-1',
            clientOrderId: 'coid-1',
            status: 'filled',
            avgFilledPrice: 149.5,
            filledQuantity: 10,
        });

        const res = await handler(makeRequest('https://example.com/api/positions/1/close'));

        expect(res.status).toBe(200);
        expect(mockExecuteSellOrder).toHaveBeenCalledWith('AAPL', 10, expect.any(String));
        expect(mockInsertTrade).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ mode: 'auto', price: 149.5, realizedPnl: 495 }),
        );
    });

    it('체결이 확정되지 않으면 포지션을 닫지 않는다 — 유령 보유를 만들지 않기 위해서다', async () => {
        mockExecuteSellOrder.mockResolvedValue({
            orderId: 'ord-2',
            clientOrderId: 'coid-2',
            status: 'pending',
        });

        const res = await handler(makeRequest('https://example.com/api/positions/1/close'));

        expect(res.status).toBe(202);
        expect(mockClosePosition).not.toHaveBeenCalled();
        expect(mockInsertTrade).not.toHaveBeenCalled();
    });

    it('브로커가 거부하면 502를 내고 DB를 건드리지 않는다', async () => {
        mockExecuteSellOrder.mockResolvedValue({
            orderId: '',
            clientOrderId: 'coid-3',
            status: 'rejected',
            rejectReason: 'insufficient-holdings',
        });

        const res = await handler(makeRequest('https://example.com/api/positions/1/close'));

        expect(res.status).toBe(502);
        expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it('주문 자체가 던지면 추적을 error로 남기고 502', async () => {
        mockExecuteSellOrder.mockRejectedValue(new Error('network down'));

        const res = await handler(makeRequest('https://example.com/api/positions/1/close'));

        expect(res.status).toBe(502);
        expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
            fakeDb,
            expect.any(String),
            expect.objectContaining({ status: 'error' }),
        );
        expect(mockClosePosition).not.toHaveBeenCalled();
    });
});
