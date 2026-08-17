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
const mockGetPendingSubmittedOrders = vi.fn();
const mockReducePositionQuantity = vi.fn();
vi.mock('../../../lib/db/queries', () => ({
    closePosition: (...args: unknown[]) => mockClosePosition(...args),
    reducePositionQuantity: (...args: unknown[]) => mockReducePositionQuantity(...args),
    getOpenPositions: (...args: unknown[]) => mockGetOpenPositions(...args),
    getPendingSubmittedOrders: (...args: unknown[]) => mockGetPendingSubmittedOrders(...args),
    insertTrade: (...args: unknown[]) => mockInsertTrade(...args),
    getConfigValue: (...args: unknown[]) => mockGetConfigValue(...args),
    createOrderTracking: (...args: unknown[]) => mockCreateOrderTracking(...args),
    updateOrderTracking: (...args: unknown[]) => mockUpdateOrderTracking(...args),
}));

// `dry_run`이 아니면 이 엔드포인트가 브로커에 실제 매도 주문을 낸다.
const mockExecuteSellOrder = vi.fn();
vi.mock('../../../lib/trading/orders', () => ({
    executeSellOrder: (...args: unknown[]) => mockExecuteSellOrder(...args),
}));

const mockGetSellableQuantity = vi.fn();
vi.mock('../../../lib/trading/account', () => ({
    getSellableQuantity: (...args: unknown[]) => mockGetSellableQuantity(...args),
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
    mockGetPendingSubmittedOrders.mockResolvedValue([]);
    mockReducePositionQuantity.mockResolvedValue(true);
    // 브로커 매도가능 수량은 기본적으로 읽히지 않음(가드 비활성) — 필요한 테스트가 덮는다.
    mockGetSellableQuantity.mockResolvedValue(null);
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
        // 체결 확정은 booking과 같은 트랜잭션 안에서만 쓴다.
        expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
            fakeDb,
            expect.any(String),
            expect.objectContaining({ status: 'filled', filledPrice: 149.5 }),
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

    it('체결 확정은 booking 트랜잭션 안에서 기록한다 — trade 없는 filled 행을 남기지 않는다', async () => {
        mockExecuteSellOrder.mockResolvedValue({
            orderId: 'ord-9',
            clientOrderId: 'coid-9',
            status: 'filled',
            avgFilledPrice: 149.5,
            filledQuantity: 10,
        });
        // 트랜잭션이 경합으로 롤백되는 상황
        mockClosePosition.mockResolvedValue(false);

        const res = await handler(makeRequest('https://example.com/api/positions/1/close'));

        expect(res.status).toBe(409);
        // 트랜잭션이 롤백됐으므로 `filled` 행이 남으면 안 된다 — 종전에는 트랜잭션
        // **밖·앞**에서 미리 써서 "trade 없는 filled" 행이 남았고, reconcile의 자동
        // 복구가 그 행을 근거로 엉뚱한(재진입으로 새로 열린) 포지션을 닫았다.
        const filledWrites = mockUpdateOrderTracking.mock.calls.filter(
            (call) => (call[2] as { status?: string })?.status === 'filled',
        );
        expect(filledWrites).toHaveLength(0);
        expect(mockInsertTrade).not.toHaveBeenCalled();
    });

    it('브로커 매도가능 수량으로 클램프하고 부분 청산으로 기록한다', async () => {
        mockGetSellableQuantity.mockResolvedValue(4);
        mockExecuteSellOrder.mockResolvedValue({
            orderId: 'ord-10',
            clientOrderId: 'coid-10',
            status: 'filled',
            avgFilledPrice: 150,
            filledQuantity: 4,
        });

        const res = await handler(makeRequest('https://example.com/api/positions/1/close'));

        expect(res.status).toBe(200);
        expect(mockExecuteSellOrder).toHaveBeenCalledWith('AAPL', 4, expect.any(String));
        expect(mockClosePosition).not.toHaveBeenCalled();
        expect(mockReducePositionQuantity).toHaveBeenCalledWith(fakeDb, 1, 4);
        expect(mockInsertTrade).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ quantity: 4, realizedPnl: 200 }),
        );
    });

    it('매도가능 수량이 0이면 주문을 내지 않는다', async () => {
        mockGetSellableQuantity.mockResolvedValue(0);

        const res = await handler(makeRequest('https://example.com/api/positions/1/close'));

        expect(res.status).toBe(409);
        expect(mockExecuteSellOrder).not.toHaveBeenCalled();
        expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it('같은 심볼 매도가 이미 떠 있으면 409 — 두 번째 전량 매도를 내지 않는다', async () => {
        mockGetPendingSubmittedOrders.mockResolvedValue([
            { symbol: 'AAPL', side: 'sell', status: 'submitted' },
        ]);

        const res = await handler(makeRequest('https://example.com/api/positions/1/close'));

        expect(res.status).toBe(409);
        expect(mockExecuteSellOrder).not.toHaveBeenCalled();
    });

    it('결말 미확정(error) 주문도 in-flight로 본다', async () => {
        mockGetPendingSubmittedOrders.mockResolvedValue([
            { symbol: 'AAPL', side: 'sell', status: 'error' },
        ]);

        const res = await handler(makeRequest('https://example.com/api/positions/1/close'));

        expect(res.status).toBe(409);
        expect(mockExecuteSellOrder).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// semi_auto: 승인 경로가 실주문이므로 이 버튼도 실주문이어야 한다
// ---------------------------------------------------------------------------

describe('POST /api/positions/[id]/close — semi_auto 모드', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../[id]/close')).POST;
        mockGetConfigValue.mockResolvedValue('semi_auto');
        mockGetOpenPositions.mockResolvedValue([
            { id: 1, symbol: 'AAPL', quantity: 10, avgPrice: '100', status: 'open' },
        ]);
        mockClosePosition.mockResolvedValue(true);
        mockInsertTrade.mockResolvedValue([]);
        mockFetchLivePrice.mockResolvedValue(150);
    });

    it('브로커에 매도 주문을 낸다 — DB만 닫으면 실계좌에 유령 보유가 남는다', async () => {
        mockExecuteSellOrder.mockResolvedValue({
            orderId: 'ord-11',
            clientOrderId: 'coid-11',
            status: 'filled',
            avgFilledPrice: 149,
            filledQuantity: 10,
        });

        const res = await handler(makeRequest('https://example.com/api/positions/1/close'));

        expect(res.status).toBe(200);
        // `api/approve/[id].ts`의 승인 경로가 semi_auto에서도 실주문을 내므로
        // 이 모드의 포지션은 실계좌에 실재한다.
        expect(mockExecuteSellOrder).toHaveBeenCalledWith('AAPL', 10, expect.any(String));
        expect(mockInsertTrade).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ mode: 'semi_auto' }),
        );
    });
});

// ---------------------------------------------------------------------------
// dry_run: 브로커를 절대 건드리지 않는다
// ---------------------------------------------------------------------------

describe('POST /api/positions/[id]/close — dry_run 모드', () => {
    it('브로커 주문을 내지 않는다', async () => {
        const handler = (await import('../[id]/close')).POST;
        mockGetConfigValue.mockResolvedValue('dry_run');
        mockGetOpenPositions.mockResolvedValue([
            { id: 1, symbol: 'AAPL', quantity: 10, avgPrice: '100', status: 'open' },
        ]);
        mockClosePosition.mockResolvedValue(true);
        mockInsertTrade.mockResolvedValue([]);
        mockFetchLivePrice.mockResolvedValue(150);

        const res = await handler(makeRequest('https://example.com/api/positions/1/close'));

        expect(res.status).toBe(200);
        expect(mockExecuteSellOrder).not.toHaveBeenCalled();
        expect(mockGetPendingSubmittedOrders).not.toHaveBeenCalled();
        expect(mockInsertTrade).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ mode: 'dry_run' }),
        );
    });
});
