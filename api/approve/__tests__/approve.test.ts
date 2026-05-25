import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import handler from '../[id]';

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
vi.mock('../../../lib/db/queries', () => ({
    approvePendingOrder: (...args: unknown[]) => mockApprovePendingOrder(...args),
    revertPendingOrder: (...args: unknown[]) => mockRevertPendingOrder(...args),
    rejectPendingOrder: (...args: unknown[]) => mockRejectPendingOrder(...args),
    getPendingOrderById: (...args: unknown[]) => mockGetPendingOrderById(...args),
    insertTrade: (...args: unknown[]) => mockInsertTrade(...args),
    openPosition: (...args: unknown[]) => mockOpenPosition(...args),
    getOpenPositionBySymbol: (...args: unknown[]) => mockGetOpenPositionBySymbol(...args),
    closePosition: (...args: unknown[]) => mockClosePosition(...args),
    getConfigValue: (...args: unknown[]) => mockGetConfigValue(...args),
    createOrderTracking: (...args: unknown[]) => mockCreateOrderTracking(...args),
    updateOrderTracking: (...args: unknown[]) => mockUpdateOrderTracking(...args),
    averageIntoPosition: (...args: unknown[]) => mockAverageIntoPosition(...args),
}));

const mockExecuteBuyOrder = vi.fn();
const mockExecuteSellOrder = vi.fn();
vi.mock('../../../lib/trading/order', () => ({
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
    mockSendErrorEmail.mockResolvedValue(undefined);
    mockExecuteBuyOrder.mockResolvedValue({
        orderId: 'ord-1',
        status: 'filled',
        filledPrice: 150,
    });
    mockExecuteSellOrder.mockResolvedValue({
        orderId: 'ord-2',
        status: 'filled',
        filledPrice: 155,
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
                    symbol: 'AAPL',
                    side: 'buy',
                    quantity: 5,
                    status: 'submitted',
                }),
            );
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
                }),
            );
        });

        it('does not create order tracking in non-auto mode', async () => {
            mockGetConfigValue.mockResolvedValue(null); // defaults to dry_run

            await handler(makeApproveRequest(1, 'approve'));

            expect(mockCreateOrderTracking).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // filledPrice missing in auto mode
    // -----------------------------------------------------------------------

    describe('filledPrice missing in auto mode', () => {
        it('returns error when filledPrice is undefined', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                status: 'filled',
                filledPrice: undefined,
            });

            const res = await handler(makeApproveRequest(1, 'approve'));

            expect(res.status).toBe(502);
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                'approve-1',
                expect.objectContaining({ status: 'fill_price_unknown' }),
            );
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                expect.stringContaining('체결가 누락'),
                expect.stringContaining('수동 확인이 필요합니다'),
            );
            expect(mockInsertTrade).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Transaction safety: closePosition false
    // -----------------------------------------------------------------------

    describe('transaction safety: closePosition false', () => {
        it('returns success with position_already_closed note on sell', async () => {
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
