import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST as handler } from '../[id]';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockIsAuthenticated = vi.fn<(req: Request) => boolean>();
vi.mock('../../_lib/auth', () => ({
    isAuthenticated: (...args: [Request]) => mockIsAuthenticated(...args),
}));

const mockGetDb = vi.fn();
vi.mock('../../_lib/db', () => ({
    getDb: () => mockGetDb(),
}));

const mockApprovePendingOrder = vi.fn();
const mockRevertPendingOrder = vi.fn();
const mockRejectPendingOrder = vi.fn();
const mockGetPendingOrderById = vi.fn();
const mockInsertTrade = vi.fn();
const mockOpenPosition = vi.fn();
const mockGetOpenPositionBySymbol = vi.fn();
const mockClosePosition = vi.fn();
const mockGetConfigValue = vi.fn();
const mockCreateOrderTracking = vi.fn();
const mockUpdateOrderTracking = vi.fn();
const mockAverageIntoPosition = vi.fn();
const mockReducePositionQuantity = vi.fn();
vi.mock('../../../lib/db/queries', () => ({
    approvePendingOrder: (...args: unknown[]) => mockApprovePendingOrder(...args),
    revertPendingOrder: (...args: unknown[]) => mockRevertPendingOrder(...args),
    rejectPendingOrder: (...args: unknown[]) => mockRejectPendingOrder(...args),
    getPendingOrderById: (...args: unknown[]) => mockGetPendingOrderById(...args),
    insertTrade: (...args: unknown[]) => mockInsertTrade(...args),
    openPosition: (...args: unknown[]) => mockOpenPosition(...args),
    getOpenPositionBySymbol: (...args: unknown[]) => mockGetOpenPositionBySymbol(...args),
    closePosition: (...args: unknown[]) => mockClosePosition(...args),
    reducePositionQuantity: (...args: unknown[]) => mockReducePositionQuantity(...args),
    getConfigValue: (...args: unknown[]) => mockGetConfigValue(...args),
    createOrderTracking: (...args: unknown[]) => mockCreateOrderTracking(...args),
    updateOrderTracking: (...args: unknown[]) => mockUpdateOrderTracking(...args),
    averageIntoPosition: (...args: unknown[]) => mockAverageIntoPosition(...args),
}));

const mockExecuteBuyOrder = vi.fn();
const mockExecuteSellOrder = vi.fn();
vi.mock('../../../lib/trading/orders', () => ({
    executeBuyOrder: (...args: unknown[]) => mockExecuteBuyOrder(...args),
    executeSellOrder: (...args: unknown[]) => mockExecuteSellOrder(...args),
}));

const mockSendErrorEmail = vi.fn();
vi.mock('../../../lib/notification/email', () => ({
    sendErrorEmail: (...args: unknown[]) => mockSendErrorEmail(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeDb = {
    fake: 'db',
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakeDb),
};

// expiresAt must be in the future relative to the fake timer (2026-05-25T14:30:00.000Z)
const fakeBuyOrder = {
    id: 1,
    symbol: 'AAPL',
    side: 'buy',
    quantity: 5,
    priceLimit: '150',
    analysisSummary: 'Strong buy signal',
    status: 'pending',
    expiresAt: '2026-05-25T15:00:00.000Z',
};

const fakeSellOrder = {
    id: 2,
    symbol: 'AAPL',
    side: 'sell',
    quantity: 10,
    priceLimit: '155',
    analysisSummary: 'Take profit',
    status: 'pending',
    expiresAt: '2026-05-25T15:00:00.000Z',
};

function makeApproveRequest(id: number, action: string): Request {
    return new Request(`https://example.com/api/approve/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
    });
}

function setupDefaults() {
    mockGetDb.mockReturnValue(fakeDb);
    mockIsAuthenticated.mockReturnValue(true);
    mockApprovePendingOrder.mockResolvedValue(true);
    mockRevertPendingOrder.mockResolvedValue(true);
    mockRejectPendingOrder.mockResolvedValue(true);
    mockGetPendingOrderById.mockResolvedValue(fakeBuyOrder);
    mockInsertTrade.mockResolvedValue([]);
    mockOpenPosition.mockResolvedValue([]);
    mockGetOpenPositionBySymbol.mockResolvedValue(null);
    mockClosePosition.mockResolvedValue(true);
    mockGetConfigValue.mockResolvedValue(null);
    mockCreateOrderTracking.mockResolvedValue([]);
    mockUpdateOrderTracking.mockResolvedValue([]);
    mockAverageIntoPosition.mockResolvedValue(undefined);
    mockReducePositionQuantity.mockResolvedValue(true);
    mockSendErrorEmail.mockResolvedValue(undefined);
    mockExecuteBuyOrder.mockResolvedValue({
        orderId: 'ord-1',
        clientOrderId: 'approve-1',
        status: 'filled',
        filledQuantity: 5,
        avgFilledPrice: 150,
    });
    mockExecuteSellOrder.mockResolvedValue({
        orderId: 'ord-2',
        clientOrderId: 'approve-2',
        status: 'filled',
        filledQuantity: 10,
        avgFilledPrice: 155,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('approve handler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-25T14:30:00.000Z'));
        setupDefaults();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    // -----------------------------------------------------------------------
    // Order tracking in auto mode
    // -----------------------------------------------------------------------

    describe('order tracking in auto mode', () => {
        it('creates order tracking before Toss API call', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });

            await handler(makeApproveRequest(1, 'approve'));

            expect(mockCreateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    idempotencyKey: 'approve-1',
                    clientOrderId: 'approve-1',
                    symbol: 'AAPL',
                    side: 'buy',
                    quantity: 5,
                    status: 'submitted',
                }),
            );
        });

        it('passes the stable clientOrderId (approve-${id}) to the Toss facade', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });

            await handler(makeApproveRequest(1, 'approve'));

            expect(mockExecuteBuyOrder).toHaveBeenCalledWith('AAPL', 5, 'approve-1');
        });

        it('updates order tracking after Toss API responds', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });

            await handler(makeApproveRequest(1, 'approve'));

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                'approve-1',
                expect.objectContaining({
                    tossOrderId: 'ord-1',
                    status: 'filled',
                    filledPrice: 150,
                    resolvedAt: expect.any(Date),
                }),
            );
        });

        it('records trade at avgFilledPrice with integer order.quantity on clean full fill (filled)', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            // clean full fill: filledQuantity == order.quantity (5), price present → book at real fill price
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                clientOrderId: 'approve-1',
                status: 'filled',
                filledQuantity: 5,
                avgFilledPrice: 151.25,
            });

            const res = await handler(makeApproveRequest(1, 'approve'));

            expect(res.status).toBe(200);
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    quantity: 5,
                    price: 151.25,
                    side: 'buy',
                    // auto buy carries the facade clientOrderId but NO realizedPnl
                    clientOrderId: 'approve-1',
                }),
            );
            // BUY booking must not set realizedPnl
            expect(mockInsertTrade.mock.calls[0]?.[1]).not.toHaveProperty('realizedPnl');
            expect(mockOpenPosition).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({ quantity: 5, avgPrice: 151.25 }),
            );
        });

        it('does not create order tracking in non-auto mode', async () => {
            mockGetConfigValue.mockResolvedValue(null); // defaults to dry_run

            await handler(makeApproveRequest(1, 'approve'));

            expect(mockCreateOrderTracking).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Kill switch (trading_enabled = false)
    // -----------------------------------------------------------------------

    describe('kill switch (trading_enabled)', () => {
        it('refuses approval and reverts order when trading_enabled is false', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_enabled') return Promise.resolve(false);
                return Promise.resolve(null);
            });

            const res = await handler(makeApproveRequest(1, 'approve'));
            const body = await res.json();

            // Must refuse with a clear error — not 200
            expect(res.status).toBe(409);
            expect(body.error).toContain('kill switch');

            // Order must NOT be placed
            expect(mockExecuteBuyOrder).not.toHaveBeenCalled();
            expect(mockExecuteSellOrder).not.toHaveBeenCalled();

            // No trade must be recorded
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockOpenPosition).not.toHaveBeenCalled();

            // Order reverted to pending so user can re-approve once trading is re-enabled
            expect(mockRevertPendingOrder).toHaveBeenCalledWith(fakeDb, 1);
        });

        it('proceeds normally when trading_enabled is true', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_enabled') return Promise.resolve(true);
                return Promise.resolve(null); // trading_mode defaults to dry_run
            });

            const res = await handler(makeApproveRequest(1, 'approve'));
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            // In dry_run (trading_mode=null=>dry_run) no Toss API should be called
            expect(mockExecuteBuyOrder).not.toHaveBeenCalled();
            // But trade must be recorded
            expect(mockInsertTrade).toHaveBeenCalled();
        });

        it('proceeds normally when trading_enabled is null (defaults to true)', async () => {
            // setupDefaults already sets mockGetConfigValue.mockResolvedValue(null) which
            // covers trading_enabled=null => true. Verify the default path still succeeds.
            const res = await handler(makeApproveRequest(1, 'approve'));
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(mockInsertTrade).toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Rejected order reverts to pending
    // -----------------------------------------------------------------------

    describe('rejected order revert', () => {
        it('reverts pending order when Toss API rejects', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: '',
                clientOrderId: 'approve-1',
                status: 'rejected',
                rejectReason: 'insufficient-funds',
            });

            const res = await handler(makeApproveRequest(1, 'approve'));
            const body = await res.json();

            expect(res.status).toBe(422);
            expect(body.error).toContain('insufficient-funds');
            expect(mockRevertPendingOrder).toHaveBeenCalledWith(fakeDb, 1);
            expect(mockInsertTrade).not.toHaveBeenCalled();
        });

        it('reverts pending order when Toss API cancels', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                clientOrderId: 'approve-1',
                status: 'canceled',
            });

            const res = await handler(makeApproveRequest(1, 'approve'));
            const body = await res.json();

            expect(res.status).toBe(422);
            expect(body.error).toContain('canceled');
            expect(mockRevertPendingOrder).toHaveBeenCalledWith(fakeDb, 1);
            expect(mockInsertTrade).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // pending / partial: accepted (202), reconcile owns confirmation
    // -----------------------------------------------------------------------

    describe('unconfirmed outcomes (pending/partial)', () => {
        it('returns 202 and records no trade when pending (not reverted)', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                clientOrderId: 'approve-1',
                status: 'pending',
            });

            const res = await handler(makeApproveRequest(1, 'approve'));
            const body = await res.json();

            expect(res.status).toBe(202);
            expect(body.accepted).toBe(true);
            expect(body.status).toBe('pending');
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockOpenPosition).not.toHaveBeenCalled();
            // order was submitted successfully — must NOT revert
            expect(mockRevertPendingOrder).not.toHaveBeenCalled();
            // tracking left unresolved (resolvedAt undefined)
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                'approve-1',
                expect.objectContaining({ status: 'pending', resolvedAt: undefined }),
            );
        });

        it('returns 202 with partial message and records no trade when partial (not reverted)', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                clientOrderId: 'approve-1',
                status: 'partial',
                filledQuantity: 3,
                avgFilledPrice: 150,
            });

            const res = await handler(makeApproveRequest(1, 'approve'));
            const body = await res.json();

            expect(res.status).toBe(202);
            expect(body.accepted).toBe(true);
            expect(body.status).toBe('partial');
            expect(body.message).toContain('부분 체결');
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockOpenPosition).not.toHaveBeenCalled();
            expect(mockRevertPendingOrder).not.toHaveBeenCalled();
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                'approve-1',
                expect.objectContaining({ status: 'partial', resolvedAt: undefined }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // Clean-full-fill guard in auto mode (Blocker fix)
    // -----------------------------------------------------------------------

    describe('clean-full-fill guard in auto mode', () => {
        it('avgFilledPrice null → needs_review + 202 + NO trade recorded', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                clientOrderId: 'approve-1',
                status: 'filled',
                filledQuantity: 5,
                avgFilledPrice: null,
            });

            const res = await handler(makeApproveRequest(1, 'approve'));

            expect(res.status).toBe(202);
            const body = await res.json();
            expect(body.accepted).toBe(true);
            expect(body.status).toBe('needs_review');
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                'approve-1',
                expect.objectContaining({ status: 'needs_review' }),
            );
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                expect.stringContaining('체결 수동확인 필요'),
                expect.any(String),
            );
            // NO trade must be booked
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockOpenPosition).not.toHaveBeenCalled();
        });

        it('fractional filledQuantity (9.5 of 10) → needs_review + 202 + NO trade', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockGetPendingOrderById.mockResolvedValue({ ...fakeBuyOrder, quantity: 10 });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                clientOrderId: 'approve-1',
                status: 'filled',
                filledQuantity: 9.5,
                avgFilledPrice: 150,
            });

            const res = await handler(makeApproveRequest(1, 'approve'));

            expect(res.status).toBe(202);
            const body = await res.json();
            expect(body.status).toBe('needs_review');
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockOpenPosition).not.toHaveBeenCalled();
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                expect.stringContaining('체결 수동확인 필요'),
                expect.stringContaining('9.5'),
            );
        });

        it('short fill (filledQuantity 7 of 10) → needs_review + 202 + NO trade', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockGetPendingOrderById.mockResolvedValue({ ...fakeBuyOrder, quantity: 10 });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                clientOrderId: 'approve-1',
                status: 'filled',
                filledQuantity: 7,
                avgFilledPrice: 150,
            });

            const res = await handler(makeApproveRequest(1, 'approve'));

            expect(res.status).toBe(202);
            const body = await res.json();
            expect(body.status).toBe('needs_review');
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockOpenPosition).not.toHaveBeenCalled();
        });

        it('clean full fill (10/10 + price present) → trade booked at avgFilledPrice with integer quantity', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockGetPendingOrderById.mockResolvedValue({ ...fakeBuyOrder, quantity: 10 });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                clientOrderId: 'approve-1',
                status: 'filled',
                filledQuantity: 10,
                avgFilledPrice: 153.75,
            });

            const res = await handler(makeApproveRequest(1, 'approve'));

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.success).toBe(true);
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    quantity: 10, // integer order.quantity, not filledQuantity
                    price: 153.75,
                }),
            );
            expect(mockOpenPosition).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({ quantity: 10, avgPrice: 153.75 }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // API error updates orderTracking to error
    // -----------------------------------------------------------------------

    describe('API error updates orderTracking', () => {
        it('marks orderTracking as error when Toss API throws', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockExecuteBuyOrder.mockRejectedValue(new Error('Network timeout'));

            const res = await handler(makeApproveRequest(1, 'approve'));

            expect(res.status).toBe(502);
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                'approve-1',
                expect.objectContaining({
                    status: 'error',
                    resolvedAt: expect.any(Date),
                }),
            );
            expect(mockRevertPendingOrder).toHaveBeenCalledWith(fakeDb, 1);
        });
    });

    // -----------------------------------------------------------------------
    // Transaction safety: closePosition false
    // -----------------------------------------------------------------------

    describe('transaction safety: closePosition false', () => {
        it('returns success with position_already_closed note on full sell', async () => {
            mockGetPendingOrderById.mockResolvedValue(fakeSellOrder);
            mockGetOpenPositionBySymbol.mockResolvedValue({
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '140',
                status: 'open',
            });
            mockClosePosition.mockResolvedValue(false);

            const res = await handler(makeApproveRequest(2, 'approve'));
            const body = await res.json();

            expect(body.note).toBe('position_already_closed');
            expect(mockInsertTrade).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Partial sell: reducePositionQuantity
    // -----------------------------------------------------------------------

    describe('partial sell support', () => {
        it('reduces position quantity when sell quantity < position quantity', async () => {
            const partialSellOrder = {
                ...fakeSellOrder,
                quantity: 4, // selling 4 of 10 shares
            };
            mockGetPendingOrderById.mockResolvedValue(partialSellOrder);
            mockGetOpenPositionBySymbol.mockResolvedValue({
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '140',
                status: 'open',
            });

            const res = await handler(makeApproveRequest(2, 'approve'));
            const body = await res.json();

            expect(body.success).toBe(true);
            expect(mockReducePositionQuantity).toHaveBeenCalledWith(fakeDb, 1, 4);
            expect(mockClosePosition).not.toHaveBeenCalled();
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'sell',
                    quantity: 4,
                    reason: expect.stringContaining('부분 매도'),
                    // (sellPrice 155 − avgPrice 140) × 4
                    realizedPnl: 60,
                    // semi_auto (default mode) → no facade order → no clientOrderId
                    clientOrderId: undefined,
                }),
            );
        });

        it('closes position fully when sell quantity >= position quantity', async () => {
            mockGetPendingOrderById.mockResolvedValue(fakeSellOrder); // quantity: 10
            mockGetOpenPositionBySymbol.mockResolvedValue({
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '140',
                status: 'open',
            });

            const res = await handler(makeApproveRequest(2, 'approve'));
            const body = await res.json();

            expect(body.success).toBe(true);
            expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 1, 155);
            expect(mockReducePositionQuantity).not.toHaveBeenCalled();
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    side: 'sell',
                    quantity: 10,
                    // (sellPrice 155 − avgPrice 140) × 10
                    realizedPnl: 150,
                    clientOrderId: undefined,
                }),
            );
        });

        it('auto-mode full close carries clientOrderId (approve-${id}) + realizedPnl', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockGetPendingOrderById.mockResolvedValue(fakeSellOrder); // id 2, qty 10
            mockGetOpenPositionBySymbol.mockResolvedValue({
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '140',
                status: 'open',
            });
            // Toss fills cleanly at 155 (avgFilledPrice), full qty
            mockExecuteSellOrder.mockResolvedValue({
                orderId: 'toss-1',
                status: 'filled',
                avgFilledPrice: 155,
                filledQuantity: 10,
            });

            const res = await handler(makeApproveRequest(2, 'approve'));
            const body = await res.json();

            expect(body.success).toBe(true);
            expect(mockInsertTrade).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    side: 'sell',
                    quantity: 10,
                    mode: 'auto',
                    clientOrderId: 'approve-2',
                    realizedPnl: 150,
                }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // No-position sell: record trade + alert
    // -----------------------------------------------------------------------

    describe('no-position sell guard', () => {
        it('records trade with warning and sends error email when no position exists', async () => {
            mockGetPendingOrderById.mockResolvedValue(fakeSellOrder);
            mockGetOpenPositionBySymbol.mockResolvedValue(null); // no position

            const res = await handler(makeApproveRequest(2, 'approve'));
            const body = await res.json();

            expect(body.success).toBe(true);
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'sell',
                    reason: expect.stringContaining('포지션 미확인'),
                }),
            );
            expect(mockClosePosition).not.toHaveBeenCalled();
            expect(mockReducePositionQuantity).not.toHaveBeenCalled();
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '포지션 미확인 매도: AAPL',
                expect.stringContaining('DB에 해당 포지션이 없습니다'),
            );
        });
    });

    // -----------------------------------------------------------------------
    // Position averaging on duplicate buy
    // -----------------------------------------------------------------------

    describe('position averaging on buy', () => {
        it('averages into existing position instead of opening a new one', async () => {
            mockGetOpenPositionBySymbol.mockResolvedValue({
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '140',
                status: 'open',
            });

            const res = await handler(makeApproveRequest(1, 'approve'));
            const body = await res.json();

            expect(body.success).toBe(true);
            expect(mockAverageIntoPosition).toHaveBeenCalledWith(fakeDb, 1, 5, 150);
            expect(mockOpenPosition).not.toHaveBeenCalled();
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    reason: expect.stringContaining('기존 포지션에 추가'),
                }),
            );
        });

        it('opens new position when no existing position', async () => {
            mockGetOpenPositionBySymbol.mockResolvedValue(null);

            await handler(makeApproveRequest(1, 'approve'));

            expect(mockOpenPosition).toHaveBeenCalled();
            expect(mockAverageIntoPosition).not.toHaveBeenCalled();
        });
    });
});
