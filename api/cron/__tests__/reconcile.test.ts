import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET as handler } from '../reconcile';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockVerifyCronSecret = vi.fn<(req: Request) => boolean>();
vi.mock('../../_lib/cron-auth', () => ({
    verifyCronSecret: (...args: [Request]) => mockVerifyCronSecret(...args),
}));

const mockGetDb = vi.fn();
vi.mock('../../_lib/db', () => ({
    getDb: () => mockGetDb(),
}));

const mockAcquireLock = vi.fn<() => Promise<string | null>>();
const mockReleaseLock = vi.fn<() => Promise<void>>();
vi.mock('../../../lib/lock', () => ({
    acquireLock: (...args: unknown[]) => mockAcquireLock(...(args as [])),
    releaseLock: (...args: unknown[]) => mockReleaseLock(...(args as [])),
}));

const mockGetPendingSubmittedOrders = vi.fn();
const mockUpdateOrderTracking = vi.fn();
const mockGetOpenPositions = vi.fn();
const mockGetConfigValue = vi.fn();
const mockGetNotificationConfig = vi.fn();
const mockStartCronRun = vi.fn();
const mockFinishCronRun = vi.fn();
const mockInsertCronDecisions = vi.fn();
vi.mock('../../../lib/db/queries', () => ({
    getPendingSubmittedOrders: (...args: unknown[]) => mockGetPendingSubmittedOrders(...args),
    updateOrderTracking: (...args: unknown[]) => mockUpdateOrderTracking(...args),
    getOpenPositions: (...args: unknown[]) => mockGetOpenPositions(...args),
    getConfigValue: (...args: unknown[]) => mockGetConfigValue(...args),
    getNotificationConfig: (...args: unknown[]) => mockGetNotificationConfig(...args),
    startCronRun: (...args: unknown[]) => mockStartCronRun(...args),
    finishCronRun: (...args: unknown[]) => mockFinishCronRun(...args),
    insertCronDecisions: (...args: unknown[]) => mockInsertCronDecisions(...args),
}));

const mockGetOrder = vi.fn();
vi.mock('../../../lib/trading/orders', () => ({
    getOrder: (...args: unknown[]) => mockGetOrder(...args),
}));

const mockCancelOrder = vi.fn();
const mockGetHoldings = vi.fn();
vi.mock('../../../lib/trading/account', () => ({
    cancelOrder: (...args: unknown[]) => mockCancelOrder(...args),
    getHoldings: (...args: unknown[]) => mockGetHoldings(...args),
}));

const mockSendErrorEmail = vi.fn();
vi.mock('../../../lib/notification/email', () => ({
    sendErrorEmail: (...args: unknown[]) => mockSendErrorEmail(...args),
}));

const mockCheckConsistency = vi.fn();
const mockAutoRecoverFilledOrders = vi.fn();
vi.mock('../../../lib/db/recovery', () => ({
    checkConsistency: (...args: unknown[]) => mockCheckConsistency(...args),
    autoRecoverFilledOrders: (...args: unknown[]) => mockAutoRecoverFilledOrders(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeDb = { fake: 'db' };

function makeRequest(authorized: boolean): Request {
    const headers = new Headers();
    if (authorized) {
        headers.set('authorization', 'Bearer test-secret');
    }
    return new Request('https://example.com/api/cron/reconcile', { headers });
}

function setupDefaults() {
    mockGetDb.mockReturnValue(fakeDb);
    mockVerifyCronSecret.mockReturnValue(true);
    mockAcquireLock.mockResolvedValue('test-lock-token');
    mockReleaseLock.mockResolvedValue(undefined);
    mockGetPendingSubmittedOrders.mockResolvedValue([]);
    mockUpdateOrderTracking.mockResolvedValue([]);
    mockSendErrorEmail.mockResolvedValue(undefined);
    mockAutoRecoverFilledOrders.mockResolvedValue({
        recovered: 0,
        failed: 0,
        details: [],
    });
    mockCheckConsistency.mockResolvedValue({
        filledOrdersWithoutTrades: 0,
        filledOrdersWithoutPositions: 0,
        openPositionsWithoutTrades: 0,
        alerts: [],
    });
    mockGetOpenPositions.mockResolvedValue([]);
    mockGetOrder.mockResolvedValue(null);
    mockCancelOrder.mockResolvedValue(undefined);
    mockGetHoldings.mockResolvedValue([]);
    // Default to 'auto' so existing holdings tests exercise the real broker path.
    mockGetConfigValue.mockResolvedValue('auto');
    // Default: email enabled with 'error' event so existing alert assertions fire.
    mockGetNotificationConfig.mockResolvedValue([
        { channel: 'email', enabled: true, target: 'test@example.com', events: ['error'] },
    ]);
    mockStartCronRun.mockResolvedValue(undefined);
    mockFinishCronRun.mockResolvedValue(undefined);
    mockInsertCronDecisions.mockResolvedValue(undefined);
}

/** Order submitted 90 min ago (> 30 min timeout window). */
function oldOrderWith(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        idempotencyKey: 'exec-abc-AAPL-buy',
        symbol: 'AAPL',
        side: 'buy',
        quantity: 10,
        tossOrderId: 'toss-1',
        submittedAt: new Date('2026-05-24T13:00:00.000Z'),
        ...overrides,
    };
}

/** Order submitted 10 min ago (within the 30 min window). */
function recentOrderWith(overrides: Record<string, unknown> = {}) {
    return {
        id: 2,
        idempotencyKey: 'exec-def-AAPL-buy',
        symbol: 'AAPL',
        side: 'buy',
        quantity: 10,
        tossOrderId: 'toss-2',
        submittedAt: new Date('2026-05-24T14:20:00.000Z'),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconcile cron handler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-24T14:30:00.000Z'));
        setupDefaults();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    // -----------------------------------------------------------------------
    // Auth
    // -----------------------------------------------------------------------

    describe('auth', () => {
        it('returns 401 when cron secret is invalid', async () => {
            mockVerifyCronSecret.mockReturnValue(false);

            const res = await handler(makeRequest(false));

            expect(res.status).toBe(401);
            expect(await res.text()).toBe('Unauthorized');
            expect(mockGetPendingSubmittedOrders).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Distributed lock
    // -----------------------------------------------------------------------

    describe('distributed lock', () => {
        it('returns skipped response when lock cannot be acquired', async () => {
            mockAcquireLock.mockResolvedValue(null);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body).toEqual({ skipped: true, reason: 'locked' });
            expect(mockGetPendingSubmittedOrders).not.toHaveBeenCalled();
        });

        it('acquires lock with 780s TTL (< maxDuration 800s)', async () => {
            await handler(makeRequest(true));

            expect(mockAcquireLock).toHaveBeenCalledWith('cron:reconcile:lock', 780);
        });

        it('releases lock after successful execution', async () => {
            await handler(makeRequest(true));

            expect(mockReleaseLock).toHaveBeenCalledWith('cron:reconcile:lock', 'test-lock-token');
        });

        it('releases lock even when handler throws', async () => {
            mockGetPendingSubmittedOrders.mockRejectedValue(new Error('DB error'));

            await expect(handler(makeRequest(true))).rejects.toThrow('DB error');

            expect(mockReleaseLock).toHaveBeenCalledWith('cron:reconcile:lock', 'test-lock-token');
        });
    });

    // -----------------------------------------------------------------------
    // Empty submitted orders
    // -----------------------------------------------------------------------

    describe('empty submitted orders', () => {
        it('returns empty results when no submitted orders exist', async () => {
            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.processed).toBe(0);
            expect(body.results).toEqual([]);
            expect(mockUpdateOrderTracking).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Timeout processing
    // -----------------------------------------------------------------------

    describe('timeout processing', () => {
        it('marks orders older than 30 minutes as timeout', async () => {
            const oldOrder = {
                id: 1,
                idempotencyKey: 'exec-abc-AAPL-buy',
                symbol: 'AAPL',
                side: 'buy',
                quantity: 10,
                submittedAt: new Date('2026-05-24T13:00:00.000Z'), // 90 min ago
            };
            mockGetPendingSubmittedOrders.mockResolvedValue([oldOrder]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(fakeDb, 'exec-abc-AAPL-buy', {
                status: 'timeout',
                resolvedAt: expect.any(Date),
            });
            expect(body.results).toEqual([{ id: 1, symbol: 'AAPL', action: 'timeout' }]);
        });

        it('sends standard alert email for buy order timeout', async () => {
            const oldBuyOrder = {
                id: 1,
                idempotencyKey: 'exec-abc-AAPL-buy',
                symbol: 'AAPL',
                side: 'buy',
                quantity: 5,
                submittedAt: new Date('2026-05-24T13:00:00.000Z'),
            };
            mockGetPendingSubmittedOrders.mockResolvedValue([oldBuyOrder]);

            await handler(makeRequest(true));

            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '미체결 주문 타임아웃: AAPL',
                expect.stringContaining('수동 확인이 필요합니다'),
            );
        });

        it('sends urgent alert email for sell order timeout', async () => {
            const oldSellOrder = {
                id: 2,
                idempotencyKey: 'exec-def-TSLA-sell',
                symbol: 'TSLA',
                side: 'sell',
                quantity: 10,
                submittedAt: new Date('2026-05-24T13:00:00.000Z'),
            };
            mockGetPendingSubmittedOrders.mockResolvedValue([oldSellOrder]);

            await handler(makeRequest(true));

            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '[긴급] 매도 주문 타임아웃: TSLA',
                expect.stringContaining('브로커에 포지션이 남아 있을 수 있습니다'),
            );
        });

        it('still marks the order timeout but skips the alert email when email is disabled', async () => {
            mockGetNotificationConfig.mockResolvedValue([
                { channel: 'email', enabled: false, target: 't@e.com', events: ['error'] },
            ]);
            const oldSellOrder = {
                id: 2,
                idempotencyKey: 'exec-def-TSLA-sell',
                symbol: 'TSLA',
                side: 'sell',
                quantity: 10,
                submittedAt: new Date('2026-05-24T13:00:00.000Z'),
            };
            mockGetPendingSubmittedOrders.mockResolvedValue([oldSellOrder]);

            await handler(makeRequest(true));

            // Order status transition still happens — only the email is suppressed.
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                'exec-def-TSLA-sell',
                expect.objectContaining({ status: 'timeout' }),
            );
            expect(mockSendErrorEmail).not.toHaveBeenCalled();
        });

        it('skips the alert email when the error event is not selected', async () => {
            mockGetNotificationConfig.mockResolvedValue([
                { channel: 'email', enabled: true, target: 't@e.com', events: ['trade_executed'] },
            ]);
            const oldSellOrder = {
                id: 2,
                idempotencyKey: 'exec-def-TSLA-sell',
                symbol: 'TSLA',
                side: 'sell',
                quantity: 10,
                submittedAt: new Date('2026-05-24T13:00:00.000Z'),
            };
            mockGetPendingSubmittedOrders.mockResolvedValue([oldSellOrder]);

            await handler(makeRequest(true));

            expect(mockSendErrorEmail).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Within-window waiting
    // -----------------------------------------------------------------------

    describe('within-window waiting', () => {
        it('marks recent orders as waiting without updating status', async () => {
            const recentOrder = {
                id: 3,
                idempotencyKey: 'exec-ghi-MSFT-buy',
                symbol: 'MSFT',
                side: 'buy',
                quantity: 3,
                submittedAt: new Date('2026-05-24T14:20:00.000Z'), // 10 min ago
            };
            mockGetPendingSubmittedOrders.mockResolvedValue([recentOrder]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockUpdateOrderTracking).not.toHaveBeenCalled();
            expect(mockSendErrorEmail).not.toHaveBeenCalled();
            expect(body.results).toEqual([{ id: 3, symbol: 'MSFT', action: 'waiting' }]);
        });
    });

    // -----------------------------------------------------------------------
    // Email alert error handling
    // -----------------------------------------------------------------------

    describe('email alert error handling', () => {
        it('does not crash when email send fails', async () => {
            const oldOrder = {
                id: 1,
                idempotencyKey: 'exec-abc-AAPL-buy',
                symbol: 'AAPL',
                side: 'buy',
                quantity: 10,
                submittedAt: new Date('2026-05-24T13:00:00.000Z'),
            };
            mockGetPendingSubmittedOrders.mockResolvedValue([oldOrder]);
            mockSendErrorEmail.mockRejectedValue(new Error('Email service down'));

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // Should still succeed with results
            expect(body.results).toEqual([{ id: 1, symbol: 'AAPL', action: 'timeout' }]);
        });
    });

    // -----------------------------------------------------------------------
    // DB consistency check
    // -----------------------------------------------------------------------

    describe('DB consistency check', () => {
        it('sends alert email when consistency issues are found', async () => {
            mockCheckConsistency.mockResolvedValue({
                filledOrdersWithoutTrades: 1,
                filledOrdersWithoutPositions: 0,
                openPositionsWithoutTrades: 0,
                alerts: ['Filled order exec-abc (AAPL buy) has no matching trade'],
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                'DB 정합성 경고 (1건)',
                'Filled order exec-abc (AAPL buy) has no matching trade',
            );
            expect(body.consistency).toEqual({
                filledOrdersWithoutTrades: 1,
                alertCount: 1,
            });
        });

        it('does not send alert email when no consistency issues', async () => {
            const res = await handler(makeRequest(true));
            const body = await res.json();

            // sendErrorEmail should not be called for consistency (only for timeouts)
            expect(mockSendErrorEmail).not.toHaveBeenCalled();
            expect(body.consistency).toEqual({
                filledOrdersWithoutTrades: 0,
                alertCount: 0,
            });
        });

        it('includes consistency data in response', async () => {
            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body).toHaveProperty('consistency');
            expect(body.consistency).toEqual({
                filledOrdersWithoutTrades: 0,
                alertCount: 0,
            });
        });
    });

    // -----------------------------------------------------------------------
    // Mixed orders (timeout + waiting)
    // -----------------------------------------------------------------------

    describe('mixed orders', () => {
        it('handles a mix of timed-out and waiting orders', async () => {
            const orders = [
                {
                    id: 1,
                    idempotencyKey: 'exec-old-AAPL-buy',
                    symbol: 'AAPL',
                    side: 'buy',
                    quantity: 5,
                    submittedAt: new Date('2026-05-24T12:00:00.000Z'), // 150 min ago
                },
                {
                    id: 2,
                    idempotencyKey: 'exec-new-TSLA-buy',
                    symbol: 'TSLA',
                    side: 'buy',
                    quantity: 3,
                    submittedAt: new Date('2026-05-24T14:25:00.000Z'), // 5 min ago
                },
            ];
            mockGetPendingSubmittedOrders.mockResolvedValue(orders);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.processed).toBe(2);
            expect(body.results).toEqual([
                { id: 1, symbol: 'AAPL', action: 'timeout' },
                { id: 2, symbol: 'TSLA', action: 'waiting' },
            ]);
            expect(mockUpdateOrderTracking).toHaveBeenCalledTimes(1);
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                'exec-old-AAPL-buy',
                expect.objectContaining({ status: 'timeout' }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // Broker resolution via getOrder
    // -----------------------------------------------------------------------

    describe('broker resolution', () => {
        it('FILLED clean full fill (filledQuantity == order.quantity) → marks tracking filled, action resolved_filled', async () => {
            mockGetPendingSubmittedOrders.mockResolvedValue([oldOrderWith()]);
            mockGetOrder.mockResolvedValue({
                orderId: 'toss-1',
                status: 'FILLED',
                filledQuantity: 10,
                avgFilledPrice: 187.5,
                canceledAt: null,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockGetOrder).toHaveBeenCalledWith('toss-1');
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(fakeDb, 'exec-abc-AAPL-buy', {
                status: 'filled',
                filledPrice: 187.5,
                resolvedAt: expect.any(Date),
            });
            expect(body.results).toEqual([{ id: 1, symbol: 'AAPL', action: 'resolved_filled' }]);
            expect(mockCancelOrder).not.toHaveBeenCalled();
            expect(mockSendErrorEmail).not.toHaveBeenCalled();
        });

        it('FILLED but filledQuantity != order.quantity → needs_review + email, NOT filled', async () => {
            // Policy: broker FILLED but actual fill (8) != tracked intended integer qty (10)
            // ⇒ do NOT mark filled (autoRecover books integer order.quantity). needs_review.
            mockGetPendingSubmittedOrders.mockResolvedValue([oldOrderWith({ quantity: 10 })]);
            mockGetOrder.mockResolvedValue({
                orderId: 'toss-1',
                status: 'FILLED',
                filledQuantity: 8,
                avgFilledPrice: 187.5,
                canceledAt: null,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(fakeDb, 'exec-abc-AAPL-buy', {
                status: 'needs_review',
                filledPrice: 187.5,
                resolvedAt: expect.any(Date),
            });
            expect(mockUpdateOrderTracking).not.toHaveBeenCalledWith(
                fakeDb,
                'exec-abc-AAPL-buy',
                expect.objectContaining({ status: 'filled' }),
            );
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '체결 수동확인 필요: AAPL',
                expect.stringContaining('체결수량(8)이 의도수량(10)'),
            );
            expect(body.results).toEqual([{ id: 1, symbol: 'AAPL', action: 'needs_review' }]);
        });

        it('FILLED with fractional filledQuantity → needs_review, NOT filled', async () => {
            // Policy: fractional fill ⇒ needs_review (integer column corruption guard).
            mockGetPendingSubmittedOrders.mockResolvedValue([oldOrderWith({ quantity: 10 })]);
            mockGetOrder.mockResolvedValue({
                orderId: 'toss-1',
                status: 'FILLED',
                filledQuantity: 9.5,
                avgFilledPrice: 187.5,
                canceledAt: null,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                'exec-abc-AAPL-buy',
                expect.objectContaining({ status: 'needs_review' }),
            );
            expect(mockUpdateOrderTracking).not.toHaveBeenCalledWith(
                fakeDb,
                'exec-abc-AAPL-buy',
                expect.objectContaining({ status: 'filled' }),
            );
            expect(mockSendErrorEmail).toHaveBeenCalled();
            expect(body.results).toEqual([{ id: 1, symbol: 'AAPL', action: 'needs_review' }]);
        });

        it('FILLED with missing avgFilledPrice → needs_review, NOT filled', async () => {
            mockGetPendingSubmittedOrders.mockResolvedValue([oldOrderWith({ quantity: 10 })]);
            mockGetOrder.mockResolvedValue({
                orderId: 'toss-1',
                status: 'FILLED',
                filledQuantity: 10,
                avgFilledPrice: null,
                canceledAt: null,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                'exec-abc-AAPL-buy',
                expect.objectContaining({ status: 'needs_review' }),
            );
            expect(mockUpdateOrderTracking).not.toHaveBeenCalledWith(
                fakeDb,
                'exec-abc-AAPL-buy',
                expect.objectContaining({ status: 'filled' }),
            );
            expect(body.results).toEqual([{ id: 1, symbol: 'AAPL', action: 'needs_review' }]);
        });

        it('REJECTED → marks tracking rejected', async () => {
            mockGetPendingSubmittedOrders.mockResolvedValue([oldOrderWith()]);
            mockGetOrder.mockResolvedValue({
                orderId: 'toss-1',
                status: 'REJECTED',
                filledQuantity: 0,
                avgFilledPrice: null,
                canceledAt: null,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(fakeDb, 'exec-abc-AAPL-buy', {
                status: 'rejected',
                resolvedAt: expect.any(Date),
            });
            expect(body.results).toEqual([{ id: 1, symbol: 'AAPL', action: 'resolved_rejected' }]);
        });

        it('CANCELED with filledQuantity 0 → marks tracking canceled', async () => {
            mockGetPendingSubmittedOrders.mockResolvedValue([oldOrderWith()]);
            mockGetOrder.mockResolvedValue({
                orderId: 'toss-1',
                status: 'CANCELED',
                filledQuantity: 0,
                avgFilledPrice: null,
                canceledAt: '2026-05-24T13:05:00.000Z',
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(fakeDb, 'exec-abc-AAPL-buy', {
                status: 'canceled',
                resolvedAt: expect.any(Date),
            });
            expect(body.results).toEqual([{ id: 1, symbol: 'AAPL', action: 'resolved_canceled' }]);
            expect(mockSendErrorEmail).not.toHaveBeenCalled();
        });

        it('CANCELED with filledQuantity > 0 → needs_review + email, NO auto-book', async () => {
            mockGetPendingSubmittedOrders.mockResolvedValue([oldOrderWith({ side: 'sell' })]);
            mockGetOrder.mockResolvedValue({
                orderId: 'toss-1',
                status: 'CANCELED',
                filledQuantity: 4,
                avgFilledPrice: 190.25,
                canceledAt: '2026-05-24T13:05:00.000Z',
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(fakeDb, 'exec-abc-AAPL-buy', {
                status: 'needs_review',
                resolvedAt: expect.any(Date),
            });
            // NOT marked 'filled' → autoRecover never books it.
            expect(mockUpdateOrderTracking).not.toHaveBeenCalledWith(
                fakeDb,
                'exec-abc-AAPL-buy',
                expect.objectContaining({ status: 'filled' }),
            );
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '부분체결 후 취소 — 수동 확인: AAPL',
                expect.stringContaining('4주 부분체결 후 취소됨'),
            );
            expect(body.results).toEqual([{ id: 1, symbol: 'AAPL', action: 'needs_review' }]);
        });

        it('PARTIAL_FILLED within window → waiting_partial, no cancel, no booking', async () => {
            mockGetPendingSubmittedOrders.mockResolvedValue([recentOrderWith()]);
            mockGetOrder.mockResolvedValue({
                orderId: 'toss-2',
                status: 'PARTIAL_FILLED',
                filledQuantity: 3,
                avgFilledPrice: 188.0,
                canceledAt: null,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockCancelOrder).not.toHaveBeenCalled();
            expect(mockUpdateOrderTracking).not.toHaveBeenCalled();
            expect(body.results).toEqual([{ id: 2, symbol: 'AAPL', action: 'waiting_partial' }]);
        });

        it('PARTIAL_FILLED past window → cancelOrder + needs_review + email', async () => {
            mockGetPendingSubmittedOrders.mockResolvedValue([oldOrderWith({ side: 'sell' })]);
            mockGetOrder.mockResolvedValue({
                orderId: 'toss-1',
                status: 'PARTIAL_FILLED',
                filledQuantity: 6,
                avgFilledPrice: 191.0,
                canceledAt: null,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockCancelOrder).toHaveBeenCalledWith('toss-1');
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(fakeDb, 'exec-abc-AAPL-buy', {
                status: 'needs_review',
                resolvedAt: expect.any(Date),
            });
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '부분체결 타임아웃 — 수동 확인: AAPL',
                expect.stringContaining('부분체결(6주 @ 191'),
            );
            expect(body.results).toEqual([{ id: 1, symbol: 'AAPL', action: 'needs_review' }]);
        });

        it('PENDING past window → cancelOrder + timeout + urgent email for sell', async () => {
            mockGetPendingSubmittedOrders.mockResolvedValue([oldOrderWith({ side: 'sell' })]);
            mockGetOrder.mockResolvedValue({
                orderId: 'toss-1',
                status: 'PENDING',
                filledQuantity: 0,
                avgFilledPrice: null,
                canceledAt: null,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockCancelOrder).toHaveBeenCalledWith('toss-1');
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(fakeDb, 'exec-abc-AAPL-buy', {
                status: 'timeout',
                resolvedAt: expect.any(Date),
            });
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '[긴급] 매도 주문 타임아웃: AAPL',
                expect.stringContaining('브로커에 포지션이 남아 있을 수 있습니다'),
            );
            expect(body.results).toEqual([{ id: 1, symbol: 'AAPL', action: 'timeout' }]);
        });

        it('PENDING within window → waiting, no cancel', async () => {
            mockGetPendingSubmittedOrders.mockResolvedValue([recentOrderWith()]);
            mockGetOrder.mockResolvedValue({
                orderId: 'toss-2',
                status: 'PENDING',
                filledQuantity: 0,
                avgFilledPrice: null,
                canceledAt: null,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockCancelOrder).not.toHaveBeenCalled();
            expect(mockUpdateOrderTracking).not.toHaveBeenCalled();
            expect(body.results).toEqual([{ id: 2, symbol: 'AAPL', action: 'waiting' }]);
        });

        it('getOrder throws (null) → falls back to age-based timeout', async () => {
            mockGetPendingSubmittedOrders.mockResolvedValue([oldOrderWith()]);
            mockGetOrder.mockRejectedValue(new Error('broker down'));

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(fakeDb, 'exec-abc-AAPL-buy', {
                status: 'timeout',
                resolvedAt: expect.any(Date),
            });
            expect(body.results).toEqual([{ id: 1, symbol: 'AAPL', action: 'timeout' }]);
        });

        it('order with no tossOrderId past window → timeout (existing path), getOrder not called', async () => {
            mockGetPendingSubmittedOrders.mockResolvedValue([oldOrderWith({ tossOrderId: null })]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockGetOrder).not.toHaveBeenCalled();
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                'exec-abc-AAPL-buy',
                expect.objectContaining({ status: 'timeout' }),
            );
            expect(body.results).toEqual([{ id: 1, symbol: 'AAPL', action: 'timeout' }]);
        });
    });

    // -----------------------------------------------------------------------
    // Holdings reconciliation
    // -----------------------------------------------------------------------

    describe('holdings reconciliation', () => {
        it('alerts when DB position quantity differs from broker quantity', async () => {
            mockGetOpenPositions.mockResolvedValue([{ symbol: 'AAPL', quantity: '10' }]);
            mockGetHoldings.mockResolvedValue([
                {
                    symbol: 'AAPL',
                    quantity: 7,
                    avgPrice: 180,
                    currentPrice: 190,
                    pnl: 70,
                    marketCountry: 'US',
                    currency: 'USD',
                },
            ]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '보유 정합성 불일치 (1건)',
                expect.stringContaining('AAPL'),
            );
            expect(body.holdings).toEqual({ mismatchCount: 1 });
        });

        it('alerts when broker holds a symbol with no open DB position', async () => {
            mockGetOpenPositions.mockResolvedValue([]);
            mockGetHoldings.mockResolvedValue([
                {
                    symbol: 'TSLA',
                    quantity: 5,
                    avgPrice: 200,
                    currentPrice: 210,
                    pnl: 50,
                    marketCountry: 'US',
                    currency: 'USD',
                },
            ]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '보유 정합성 불일치 (1건)',
                expect.stringContaining('TSLA'),
            );
            expect(body.holdings).toEqual({ mismatchCount: 1 });
        });

        it('does not alert when holdings match within epsilon (fractional)', async () => {
            mockGetOpenPositions.mockResolvedValue([{ symbol: 'AAPL', quantity: '10' }]);
            mockGetHoldings.mockResolvedValue([
                {
                    symbol: 'AAPL',
                    quantity: 10.005,
                    avgPrice: 180,
                    currentPrice: 190,
                    pnl: 0,
                    marketCountry: 'US',
                    currency: 'USD',
                },
            ]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockSendErrorEmail).not.toHaveBeenCalled();
            expect(body.holdings).toEqual({ mismatchCount: 0 });
        });

        it('skips holdings reconciliation gracefully when getHoldings throws', async () => {
            mockGetHoldings.mockRejectedValue(new Error('broker down'));

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockGetOpenPositions).not.toHaveBeenCalled();
            expect(body.holdings).toEqual({ mismatchCount: 0 });
        });

        it('non-US holding (KRW/KR) with no DB position → NOT treated as mismatch (filtered out)', async () => {
            // Korean stock with no matching DB position should be silently ignored.
            mockGetOpenPositions.mockResolvedValue([]);
            mockGetHoldings.mockResolvedValue([
                {
                    symbol: '005930', // Samsung KRX
                    quantity: 100,
                    avgPrice: 70000,
                    currentPrice: 72000,
                    pnl: 200000,
                    marketCountry: 'KR',
                    currency: 'KRW',
                },
            ]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockSendErrorEmail).not.toHaveBeenCalled();
            expect(body.holdings).toEqual({ mismatchCount: 0 });
        });

        it('US holding with no DB position → still triggers mismatch alert', async () => {
            // A US holding with no DB position is a genuine discrepancy and must alert.
            mockGetOpenPositions.mockResolvedValue([]);
            mockGetHoldings.mockResolvedValue([
                {
                    symbol: 'NVDA',
                    quantity: 3,
                    avgPrice: 900,
                    currentPrice: 920,
                    pnl: 60,
                    marketCountry: 'US',
                    currency: 'USD',
                },
                {
                    symbol: '005930', // non-US — must be filtered
                    quantity: 50,
                    avgPrice: 70000,
                    currentPrice: 72000,
                    pnl: 100000,
                    marketCountry: 'KR',
                    currency: 'KRW',
                },
            ]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // Only NVDA (US) triggers the mismatch; Samsung must be silently dropped.
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '보유 정합성 불일치 (1건)',
                expect.stringContaining('NVDA'),
            );
            expect(body.holdings).toEqual({ mismatchCount: 1 });
        });

        it('dry_run mode → getHoldings NOT called, no mismatch email, mismatchCount 0', async () => {
            // In dry_run the DB positions are simulated, so comparing them against
            // the real broker account would produce constant false-positive alerts.
            mockGetConfigValue.mockResolvedValue('dry_run');
            mockGetOpenPositions.mockResolvedValue([{ symbol: 'AAPL', quantity: '10' }]);
            mockGetHoldings.mockResolvedValue([
                {
                    symbol: 'AAPL',
                    quantity: 5, // would be a mismatch if the gate were absent
                    avgPrice: 180,
                    currentPrice: 190,
                    pnl: 50,
                    marketCountry: 'US',
                    currency: 'USD',
                },
            ]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockGetHoldings).not.toHaveBeenCalled();
            expect(mockSendErrorEmail).not.toHaveBeenCalled();
            expect(body.holdings).toEqual({ mismatchCount: 0 });
        });

        it('auto mode → getHoldings IS called and mismatch alert fires', async () => {
            mockGetConfigValue.mockResolvedValue('auto');
            mockGetOpenPositions.mockResolvedValue([{ symbol: 'AAPL', quantity: '10' }]);
            mockGetHoldings.mockResolvedValue([
                {
                    symbol: 'AAPL',
                    quantity: 7,
                    avgPrice: 180,
                    currentPrice: 190,
                    pnl: 70,
                    marketCountry: 'US',
                    currency: 'USD',
                },
            ]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockGetHoldings).toHaveBeenCalled();
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '보유 정합성 불일치 (1건)',
                expect.stringContaining('AAPL'),
            );
            expect(body.holdings).toEqual({ mismatchCount: 1 });
        });
    });

    // -----------------------------------------------------------------------
    // Audit logging (cron_runs + cron_decisions)
    // -----------------------------------------------------------------------

    describe('audit logging', () => {
        it('calls startCronRun with cronType reconcile before lock attempt', async () => {
            await handler(makeRequest(true));

            expect(mockStartCronRun).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({ cronType: 'reconcile' }),
            );
        });

        it('normal run → finishCronRun called with status:completed, outcome:completed', async () => {
            await handler(makeRequest(true));

            expect(mockFinishCronRun).toHaveBeenCalledWith(
                fakeDb,
                expect.stringMatching(/^reconcile-/),
                expect.objectContaining({ status: 'completed', outcome: 'completed' }),
            );
        });

        it('normal run → insertCronDecisions called with reconcile and mapped results', async () => {
            const orders = [
                {
                    id: 1,
                    idempotencyKey: 'exec-abc-AAPL-buy',
                    symbol: 'AAPL',
                    side: 'buy',
                    quantity: 10,
                    submittedAt: new Date('2026-05-24T13:00:00.000Z'), // timed out
                },
            ];
            mockGetPendingSubmittedOrders.mockResolvedValue(orders);

            await handler(makeRequest(true));

            expect(mockInsertCronDecisions).toHaveBeenCalledWith(
                fakeDb,
                expect.stringMatching(/^reconcile-/),
                'reconcile',
                [{ symbol: 'AAPL', action: 'timeout' }],
            );
        });

        it('locked run → finishCronRun called with status:skipped, outcome:locked', async () => {
            mockAcquireLock.mockResolvedValue(null);

            await handler(makeRequest(true));

            expect(mockFinishCronRun).toHaveBeenCalledWith(
                fakeDb,
                expect.stringMatching(/^reconcile-/),
                expect.objectContaining({ status: 'skipped', outcome: 'locked' }),
            );
        });

        it('locked run → insertCronDecisions called with empty decisions array', async () => {
            mockAcquireLock.mockResolvedValue(null);

            await handler(makeRequest(true));

            expect(mockInsertCronDecisions).toHaveBeenCalledWith(
                fakeDb,
                expect.stringMatching(/^reconcile-/),
                'reconcile',
                [],
            );
        });

        it('thrown exception → finishCronRun called with status:error, exception re-thrown', async () => {
            mockGetPendingSubmittedOrders.mockRejectedValue(new Error('DB exploded'));

            await expect(handler(makeRequest(true))).rejects.toThrow('DB exploded');

            expect(mockFinishCronRun).toHaveBeenCalledWith(
                fakeDb,
                expect.stringMatching(/^reconcile-/),
                expect.objectContaining({ status: 'error', error: 'DB exploded' }),
            );
        });

        it('audit write rejects → reconcile still returns normally (best-effort)', async () => {
            mockFinishCronRun.mockRejectedValue(new Error('audit DB down'));
            mockInsertCronDecisions.mockRejectedValue(new Error('audit DB down'));

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // Audit failure must not break normal reconcile response
            expect(res.status).toBe(200);
            expect(body.processed).toBe(0);
        });

        it('completed summary includes processed, recovered, consistencyAlerts, holdingsMismatches, actionsByType', async () => {
            const orders = [
                {
                    id: 1,
                    idempotencyKey: 'exec-abc-AAPL-buy',
                    symbol: 'AAPL',
                    side: 'buy',
                    quantity: 10,
                    submittedAt: new Date('2026-05-24T13:00:00.000Z'),
                },
                {
                    id: 2,
                    idempotencyKey: 'exec-def-TSLA-buy',
                    symbol: 'TSLA',
                    side: 'buy',
                    quantity: 5,
                    submittedAt: new Date('2026-05-24T14:20:00.000Z'), // recent → waiting
                },
            ];
            mockGetPendingSubmittedOrders.mockResolvedValue(orders);
            mockAutoRecoverFilledOrders.mockResolvedValue({ recovered: 1, failed: 0, details: [] });
            mockCheckConsistency.mockResolvedValue({
                filledOrdersWithoutTrades: 0,
                filledOrdersWithoutPositions: 0,
                openPositionsWithoutTrades: 0,
                alerts: ['some-alert'],
            });

            await handler(makeRequest(true));

            expect(mockFinishCronRun).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({
                    status: 'completed',
                    outcome: 'completed',
                    summary: expect.objectContaining({
                        processed: 2,
                        recovered: 1,
                        recoveryFailed: 0,
                        consistencyAlerts: 1,
                        holdingsMismatches: 0,
                        actionsByType: { timeout: 1, waiting: 1 },
                    }),
                }),
            );
        });
    });
});
