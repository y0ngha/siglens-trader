import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTossFetch = vi.fn();
class FakeTossApiError extends Error {
    constructor(
        public code: string,
        msg: string,
        public status: number,
    ) {
        super(msg);
    }
}
vi.mock('../client', () => ({
    tossFetch: (...args: unknown[]) => mockTossFetch(...args),
    TossApiError: FakeTossApiError,
}));

vi.stubGlobal('crypto', { randomUUID: () => 'uuid-fixed-0000-0000-000000000000' });

describe('orders', () => {
    beforeEach(() => {
        vi.resetModules();
        mockTossFetch.mockReset();
    });

    it('worst: 빈 심볼 → Invalid symbol', async () => {
        const { executeBuyOrder } = await import('../orders');
        await expect(executeBuyOrder('', 10)).rejects.toThrow('Invalid symbol');
    });
    it('worst: 수량 0 → 양의 정수', async () => {
        const { executeBuyOrder } = await import('../orders');
        await expect(executeBuyOrder('AAPL', 0)).rejects.toThrow('positive integer');
    });
    it('worst: 소수 수량 거부', async () => {
        const { executeSellOrder } = await import('../orders');
        await expect(executeSellOrder('AAPL', 2.5)).rejects.toThrow('positive integer');
    });

    it('issueOrder: BUY/MARKET, quantity string, clientOrderId 전송', async () => {
        mockTossFetch
            .mockResolvedValueOnce({ orderId: 'o1', clientOrderId: 'co1' })
            .mockResolvedValueOnce({
                orderId: 'o1',
                status: 'FILLED',
                execution: { filledQuantity: '10', averageFilledPrice: '70000' },
            });
        const { executeBuyOrder } = await import('../orders');
        await executeBuyOrder('005930', 10, 'co1');
        const [method, path, opts] = mockTossFetch.mock.calls[0];
        expect(method).toBe('POST');
        expect(path).toBe('/api/v1/orders');
        expect(opts.account).toBe(true);
        expect(opts.body).toEqual({
            clientOrderId: 'co1',
            symbol: '005930',
            side: 'BUY',
            orderType: 'MARKET',
            quantity: '10',
        });
    });

    it('clientOrderId 미전달 시 randomUUID 사용', async () => {
        mockTossFetch.mockResolvedValueOnce({ orderId: 'o1' }).mockResolvedValueOnce({
            orderId: 'o1',
            status: 'FILLED',
            execution: { filledQuantity: '5', averageFilledPrice: '100' },
        });
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 5);
        expect(outcome.clientOrderId).toBe('uuid-fixed-0000-0000-000000000000');
    });

    it('FILLED 즉시 → status filled + 체결가/수량', async () => {
        mockTossFetch.mockResolvedValueOnce({ orderId: 'o1' }).mockResolvedValueOnce({
            orderId: 'o1',
            status: 'FILLED',
            execution: { filledQuantity: '10', averageFilledPrice: '292.18' },
        });
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 10, 'c1');
        expect(outcome).toMatchObject({
            orderId: 'o1',
            status: 'filled',
            filledQuantity: 10,
            avgFilledPrice: 292.18,
        });
    });

    it('worst: 끝까지 PENDING이면 status pending', async () => {
        mockTossFetch.mockResolvedValueOnce({ orderId: 'o1' }).mockResolvedValue({
            orderId: 'o1',
            status: 'PENDING',
            execution: { filledQuantity: '0', averageFilledPrice: null },
        });
        const { executeBuyOrder } = await import('../orders');
        vi.useFakeTimers();
        const p = executeBuyOrder('AAPL', 10, 'c1');
        await vi.runAllTimersAsync();
        const outcome = await p;
        vi.useRealTimers();
        expect(outcome.status).toBe('pending');
        // 1 issueOrder + 3 getOrder polls
        expect(mockTossFetch).toHaveBeenCalledTimes(4);
    });

    it('PARTIAL_FILLED → status partial + 체결분', async () => {
        mockTossFetch.mockResolvedValueOnce({ orderId: 'o1' }).mockResolvedValueOnce({
            orderId: 'o1',
            status: 'PARTIAL_FILLED',
            execution: { filledQuantity: '3', averageFilledPrice: '50' },
        });
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 10, 'c1');
        expect(outcome.status).toBe('partial');
        expect(outcome.filledQuantity).toBe(3);
        // 1 issueOrder + 1 poll (early return proves the loop exits immediately)
        expect(mockTossFetch).toHaveBeenCalledTimes(2);
    });

    it('REJECTED 폴링 → status rejected', async () => {
        mockTossFetch.mockResolvedValueOnce({ orderId: 'o1' }).mockResolvedValueOnce({
            orderId: 'o1',
            status: 'REJECTED',
            execution: { filledQuantity: '0', averageFilledPrice: null },
        });
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 10, 'c1');
        expect(outcome.status).toBe('rejected');
    });

    it('CANCELED 폴링 → status canceled', async () => {
        mockTossFetch.mockResolvedValueOnce({ orderId: 'o1' }).mockResolvedValueOnce({
            orderId: 'o1',
            status: 'CANCELED',
            execution: { filledQuantity: '0', averageFilledPrice: null },
        });
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 10, 'c1');
        expect(outcome.status).toBe('canceled');
    });

    it('worst: 422 insufficient-buying-power → rejected(rejectReason=code)', async () => {
        mockTossFetch.mockRejectedValueOnce(
            new FakeTossApiError('insufficient-buying-power', '부족', 422),
        );
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 10, 'c1');
        expect(outcome.status).toBe('rejected');
        expect(outcome.rejectReason).toBe('insufficient-buying-power');
    });

    it('worst: 500 시스템 오류는 throw 전파', async () => {
        mockTossFetch.mockRejectedValueOnce(new FakeTossApiError('internal-error', 'fail', 500));
        const { executeBuyOrder } = await import('../orders');
        await expect(executeBuyOrder('AAPL', 10, 'c1')).rejects.toThrow();
    });

    it('worst: 비-TossApiError(네트워크) throw 전파', async () => {
        mockTossFetch.mockRejectedValueOnce(new TypeError('network'));
        const { executeBuyOrder } = await import('../orders');
        await expect(executeBuyOrder('AAPL', 10, 'c1')).rejects.toThrow('network');
    });

    it('executeSellOrder: side SELL 전송', async () => {
        mockTossFetch.mockResolvedValueOnce({ orderId: 'o2' }).mockResolvedValueOnce({
            orderId: 'o2',
            status: 'FILLED',
            execution: { filledQuantity: '4', averageFilledPrice: '10' },
        });
        const { executeSellOrder } = await import('../orders');
        await executeSellOrder('AAPL', 4, 'c2');
        expect(mockTossFetch.mock.calls[0][2].body.side).toBe('SELL');
    });

    it('getOrder: Order를 OrderDetail로 정규화', async () => {
        mockTossFetch.mockResolvedValueOnce({
            orderId: 'o1',
            status: 'FILLED',
            canceledAt: null,
            execution: { filledQuantity: '10', averageFilledPrice: '70000' },
        });
        const { getOrder } = await import('../orders');
        const detail = await getOrder('o1');
        expect(detail).toEqual({
            orderId: 'o1',
            status: 'FILLED',
            filledQuantity: 10,
            avgFilledPrice: 70000,
            canceledAt: null,
        });
    });

    it('worst: getOrder execution 누락 시 filledQuantity 0, avgFilledPrice null', async () => {
        mockTossFetch.mockResolvedValueOnce({ orderId: 'o1', status: 'PENDING', canceledAt: null });
        const { getOrder } = await import('../orders');
        const detail = await getOrder('o1');
        expect(detail.filledQuantity).toBe(0);
        expect(detail.avgFilledPrice).toBeNull();
    });

    // Fix 1: 일시적/모호한 4xx는 rejected로 삼키지 않고 rethrow
    it('worst: 401 Unauthorized → executeBuyOrder는 throw (rejected 아님)', async () => {
        mockTossFetch.mockRejectedValueOnce(
            new FakeTossApiError('unauthorized', 'Unauthorized', 401),
        );
        const { executeBuyOrder } = await import('../orders');
        await expect(executeBuyOrder('AAPL', 10, 'c1')).rejects.toThrow();
    });

    it('worst: 403 Forbidden → executeBuyOrder는 throw (rejected 아님)', async () => {
        mockTossFetch.mockRejectedValueOnce(new FakeTossApiError('forbidden', 'Forbidden', 403));
        const { executeBuyOrder } = await import('../orders');
        await expect(executeBuyOrder('AAPL', 10, 'c1')).rejects.toThrow();
    });

    it('worst: 429 rate-limit → executeBuyOrder는 throw (rejected 아님)', async () => {
        mockTossFetch.mockRejectedValueOnce(
            new FakeTossApiError('rate-limit-exceeded', 'Too Many Requests', 429),
        );
        const { executeBuyOrder } = await import('../orders');
        await expect(executeBuyOrder('AAPL', 10, 'c1')).rejects.toThrow();
    });

    it('worst: 409 idempotency-key-conflict → executeBuyOrder는 throw (rejected 아님)', async () => {
        mockTossFetch.mockRejectedValueOnce(
            new FakeTossApiError('idempotency-key-conflict', '충돌', 409),
        );
        const { executeBuyOrder } = await import('../orders');
        await expect(executeBuyOrder('AAPL', 10, 'c1')).rejects.toThrow();
    });

    it('400 invalid-request → rejected outcome (진짜 비즈니스 거부)', async () => {
        mockTossFetch.mockRejectedValueOnce(
            new FakeTossApiError('invalid-request', '잘못된 요청', 400),
        );
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 10, 'c1');
        expect(outcome.status).toBe('rejected');
        expect(outcome.rejectReason).toBe('invalid-request');
    });

    // Fix 2: getOrder 폴링 실패 시 orderId 보존하여 pending 반환
    it('worst: issueOrder 성공 후 getOrder throw → orderId 보존한 pending 반환 (throw 아님)', async () => {
        mockTossFetch
            .mockResolvedValueOnce({ orderId: 'o1' })
            .mockRejectedValueOnce(new FakeTossApiError('internal-error', 'poll fail', 500));
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 10, 'c1');
        expect(outcome.status).toBe('pending');
        expect(outcome.orderId).toBe('o1');
        expect(outcome.clientOrderId).toBe('c1');
    });

    // Fix 4: clientOrderId 길이/형식 검증
    it('worst: clientOrderId 37자 → rejects /clientOrderId/', async () => {
        const { executeBuyOrder } = await import('../orders');
        await expect(executeBuyOrder('AAPL', 1, 'x'.repeat(37))).rejects.toThrow(/clientOrderId/);
    });
});
