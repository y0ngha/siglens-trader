import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import handler from '../reconcile';

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

const mockAcquireLock = vi.fn<() => Promise<boolean>>();
const mockReleaseLock = vi.fn<() => Promise<void>>();
vi.mock('../../../lib/lock', () => ({
    acquireLock: (...args: unknown[]) => mockAcquireLock(...(args as [])),
    releaseLock: (...args: unknown[]) => mockReleaseLock(...(args as [])),
}));

const mockGetPendingSubmittedOrders = vi.fn();
const mockUpdateOrderTracking = vi.fn();
vi.mock('../../../lib/db/queries', () => ({
    getPendingSubmittedOrders: (...args: unknown[]) => mockGetPendingSubmittedOrders(...args),
    updateOrderTracking: (...args: unknown[]) => mockUpdateOrderTracking(...args),
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
    mockAcquireLock.mockResolvedValue(true);
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
            mockAcquireLock.mockResolvedValue(false);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body).toEqual({ skipped: true, reason: 'locked' });
            expect(mockGetPendingSubmittedOrders).not.toHaveBeenCalled();
        });

        it('acquires lock with 5-minute TTL', async () => {
            await handler(makeRequest(true));

            expect(mockAcquireLock).toHaveBeenCalledWith('cron:reconcile:lock', 300);
        });

        it('releases lock after successful execution', async () => {
            await handler(makeRequest(true));

            expect(mockReleaseLock).toHaveBeenCalledWith('cron:reconcile:lock');
        });

        it('releases lock even when handler throws', async () => {
            mockGetPendingSubmittedOrders.mockRejectedValue(new Error('DB error'));

            await expect(handler(makeRequest(true))).rejects.toThrow('DB error');

            expect(mockReleaseLock).toHaveBeenCalledWith('cron:reconcile:lock');
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
});
