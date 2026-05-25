import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TossOrderResponse, TossBalance } from '../types';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
        json: () => Promise.resolve(body),
    } as Response;
}

describe('toss-client', () => {
    beforeEach(() => {
        vi.stubEnv('TOSS_APP_KEY', 'test-app-key');
        vi.stubEnv('TOSS_SECRET_KEY', 'test-secret-key');
        vi.stubEnv('TOSS_ACCOUNT_NO', '1234567890');
        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    describe('submitOrder', () => {
        it('returns TossOrderResponse on successful submission', async () => {
            const { submitOrder } = await import('../toss-client');
            const expectedResponse: TossOrderResponse = {
                orderId: 'ORD-001',
                status: 'submitted',
                message: 'Order accepted',
            };
            mockFetch.mockResolvedValueOnce(mockResponse(expectedResponse));

            const result = await submitOrder({
                symbol: '005930',
                side: 'buy',
                orderType: 'market',
                quantity: 10,
            });

            expect(result).toEqual(expectedResponse);
        });

        it('includes all fields in request body', async () => {
            const { submitOrder } = await import('../toss-client');
            mockFetch.mockResolvedValueOnce(mockResponse({ orderId: 'ORD-002', status: 'filled' }));

            await submitOrder({
                symbol: '035720',
                side: 'sell',
                orderType: 'limit',
                quantity: 5,
                price: 50000,
            });

            expect(mockFetch).toHaveBeenCalledOnce();
            const [url, options] = mockFetch.mock.calls[0];
            expect(url).toBe('https://api.tossinvest.com/v1/orders');
            expect(options.method).toBe('POST');
            expect(options.headers).toEqual({
                'Content-Type': 'application/json',
                Authorization: 'Bearer test-secret-key',
                'X-App-Key': 'test-app-key',
            });

            const body = JSON.parse(options.body);
            expect(body).toEqual({
                accountNo: '1234567890',
                symbol: '035720',
                side: 'sell',
                orderType: 'limit',
                quantity: 5,
                price: 50000,
            });
        });

        it('includes X-Idempotency-Key header when idempotencyKey is provided', async () => {
            const { submitOrder } = await import('../toss-client');
            mockFetch.mockResolvedValueOnce(mockResponse({ orderId: 'ORD-003', status: 'filled' }));

            await submitOrder(
                { symbol: '005930', side: 'buy', orderType: 'market', quantity: 10 },
                'exec-abc-005930-buy',
            );

            const [, options] = mockFetch.mock.calls[0];
            expect(options.headers).toEqual({
                'Content-Type': 'application/json',
                Authorization: 'Bearer test-secret-key',
                'X-App-Key': 'test-app-key',
                'X-Idempotency-Key': 'exec-abc-005930-buy',
            });
        });

        it('does not include X-Idempotency-Key header when not provided', async () => {
            const { submitOrder } = await import('../toss-client');
            mockFetch.mockResolvedValueOnce(mockResponse({ orderId: 'ORD-004', status: 'filled' }));

            await submitOrder({ symbol: '005930', side: 'buy', orderType: 'market', quantity: 10 });

            const [, options] = mockFetch.mock.calls[0];
            expect(options.headers).not.toHaveProperty('X-Idempotency-Key');
        });

        it('throws when TOSS_APP_KEY is missing', async () => {
            vi.stubEnv('TOSS_APP_KEY', '');
            // Re-import to pick up env change in the closure
            const { submitOrder } = await import('../toss-client');

            await expect(
                submitOrder({ symbol: '005930', side: 'buy', orderType: 'market', quantity: 1 }),
            ).rejects.toThrow('TOSS_APP_KEY and TOSS_SECRET_KEY are required');
        });

        it('throws when TOSS_SECRET_KEY is missing', async () => {
            vi.stubEnv('TOSS_SECRET_KEY', '');
            const { submitOrder } = await import('../toss-client');

            await expect(
                submitOrder({ symbol: '005930', side: 'buy', orderType: 'market', quantity: 1 }),
            ).rejects.toThrow('TOSS_APP_KEY and TOSS_SECRET_KEY are required');
        });

        it('throws when TOSS_ACCOUNT_NO is missing', async () => {
            vi.stubEnv('TOSS_ACCOUNT_NO', '');
            const { submitOrder } = await import('../toss-client');

            await expect(
                submitOrder({ symbol: '005930', side: 'buy', orderType: 'market', quantity: 1 }),
            ).rejects.toThrow('TOSS_ACCOUNT_NO is required');
        });

        it('throws with status and body when API returns 400', async () => {
            const { submitOrder } = await import('../toss-client');
            mockFetch.mockResolvedValueOnce(mockResponse('Invalid symbol', 400));

            await expect(
                submitOrder({ symbol: 'INVALID', side: 'buy', orderType: 'market', quantity: 1 }),
            ).rejects.toThrow('Toss API POST /v1/orders failed: 400 Invalid symbol');
        });

        it('throws with status and body when API returns 500', async () => {
            const { submitOrder } = await import('../toss-client');
            mockFetch.mockResolvedValueOnce(mockResponse('Internal Server Error', 500));

            await expect(
                submitOrder({ symbol: '005930', side: 'buy', orderType: 'market', quantity: 1 }),
            ).rejects.toThrow('Toss API POST /v1/orders failed: 500 Internal Server Error');
        });

        it('propagates network failure from fetch', async () => {
            const { submitOrder } = await import('../toss-client');
            mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

            await expect(
                submitOrder({ symbol: '005930', side: 'buy', orderType: 'market', quantity: 1 }),
            ).rejects.toThrow('fetch failed');
        });

        it('propagates AbortError on timeout', async () => {
            const { submitOrder } = await import('../toss-client');
            mockFetch.mockRejectedValueOnce(
                new DOMException('The operation was aborted', 'AbortError'),
            );

            await expect(
                submitOrder({ symbol: '005930', side: 'buy', orderType: 'market', quantity: 1 }),
            ).rejects.toThrow('The operation was aborted');
        });

        it('throws on malformed (non-JSON) response body', async () => {
            const { submitOrder } = await import('../toss-client');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: () => Promise.resolve('not json'),
                json: () => Promise.reject(new SyntaxError('Unexpected token')),
            } as Response);

            await expect(
                submitOrder({ symbol: '005930', side: 'buy', orderType: 'market', quantity: 1 }),
            ).rejects.toThrow('Unexpected token');
        });

        it('handles 200 with empty object response', async () => {
            const { submitOrder } = await import('../toss-client');
            mockFetch.mockResolvedValueOnce(mockResponse({}));

            const result = await submitOrder({
                symbol: '005930',
                side: 'buy',
                orderType: 'market',
                quantity: 1,
            });
            // Empty object is valid JSON — returned as-is, caller handles missing fields
            expect(result).toEqual({});
        });
    });

    describe('getBalances', () => {
        it('returns array of TossBalance', async () => {
            const { getBalances } = await import('../toss-client');
            const expectedBalances: TossBalance[] = [
                {
                    symbol: '005930',
                    quantity: 100,
                    avgPrice: 70000,
                    currentPrice: 72000,
                    pnl: 200000,
                },
                {
                    symbol: '035720',
                    quantity: 50,
                    avgPrice: 45000,
                    currentPrice: 48000,
                    pnl: 150000,
                },
            ];
            mockFetch.mockResolvedValueOnce(mockResponse(expectedBalances));

            const result = await getBalances();

            expect(result).toEqual(expectedBalances);
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.tossinvest.com/v1/accounts/1234567890/balances',
                expect.objectContaining({ method: 'GET' }),
            );
        });

        it('throws when API returns 401', async () => {
            const { getBalances } = await import('../toss-client');
            mockFetch.mockResolvedValueOnce(mockResponse('Unauthorized', 401));

            await expect(getBalances()).rejects.toThrow(
                'Toss API GET /v1/accounts/1234567890/balances failed: 401 Unauthorized',
            );
        });

        it('returns empty array when API responds with empty list', async () => {
            const { getBalances } = await import('../toss-client');
            mockFetch.mockResolvedValueOnce(mockResponse([]));

            const result = await getBalances();

            expect(result).toEqual([]);
        });

        it('throws when TOSS_ACCOUNT_NO is missing', async () => {
            vi.stubEnv('TOSS_ACCOUNT_NO', '');
            const { getBalances } = await import('../toss-client');

            await expect(getBalances()).rejects.toThrow('TOSS_ACCOUNT_NO is required');
        });
    });
});

describe('order', () => {
    beforeEach(() => {
        vi.stubEnv('TOSS_APP_KEY', 'test-app-key');
        vi.stubEnv('TOSS_SECRET_KEY', 'test-secret-key');
        vi.stubEnv('TOSS_ACCOUNT_NO', '1234567890');
        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    describe('executeBuyOrder — input validation', () => {
        it('throws when symbol is empty string', async () => {
            const { executeBuyOrder } = await import('../order');
            await expect(executeBuyOrder('', 10)).rejects.toThrow('Invalid symbol');
        });

        it('throws when quantity is 0', async () => {
            const { executeBuyOrder } = await import('../order');
            await expect(executeBuyOrder('005930', 0)).rejects.toThrow(
                'Quantity must be a positive integer',
            );
        });

        it('throws when quantity is negative', async () => {
            const { executeBuyOrder } = await import('../order');
            await expect(executeBuyOrder('005930', -5)).rejects.toThrow(
                'Quantity must be a positive integer',
            );
        });

        it('throws when quantity is NaN', async () => {
            const { executeBuyOrder } = await import('../order');
            await expect(executeBuyOrder('005930', NaN)).rejects.toThrow(
                'Quantity must be a positive integer',
            );
        });

        it('throws when quantity is a float', async () => {
            const { executeBuyOrder } = await import('../order');
            await expect(executeBuyOrder('005930', 2.5)).rejects.toThrow(
                'Quantity must be a positive integer',
            );
        });
    });

    describe('executeSellOrder — input validation', () => {
        it('throws when symbol is empty string', async () => {
            const { executeSellOrder } = await import('../order');
            await expect(executeSellOrder('', 10)).rejects.toThrow('Invalid symbol');
        });

        it('throws when quantity is 0', async () => {
            const { executeSellOrder } = await import('../order');
            await expect(executeSellOrder('005930', 0)).rejects.toThrow(
                'Quantity must be a positive integer',
            );
        });

        it('throws when quantity is negative', async () => {
            const { executeSellOrder } = await import('../order');
            await expect(executeSellOrder('005930', -5)).rejects.toThrow(
                'Quantity must be a positive integer',
            );
        });

        it('throws when quantity is NaN', async () => {
            const { executeSellOrder } = await import('../order');
            await expect(executeSellOrder('005930', NaN)).rejects.toThrow(
                'Quantity must be a positive integer',
            );
        });

        it('throws when quantity is a float', async () => {
            const { executeSellOrder } = await import('../order');
            await expect(executeSellOrder('005930', 2.5)).rejects.toThrow(
                'Quantity must be a positive integer',
            );
        });
    });

    describe('executeBuyOrder', () => {
        it('delegates to submitOrder with side=buy and orderType=market', async () => {
            const { executeBuyOrder } = await import('../order');
            const expectedResponse: TossOrderResponse = {
                orderId: 'ORD-BUY-001',
                status: 'filled',
                filledPrice: 70000,
                filledQuantity: 10,
            };
            mockFetch.mockResolvedValueOnce(mockResponse(expectedResponse));

            const result = await executeBuyOrder('005930', 10);

            expect(result).toEqual(expectedResponse);
            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.side).toBe('buy');
            expect(body.orderType).toBe('market');
            expect(body.symbol).toBe('005930');
            expect(body.quantity).toBe(10);
        });

        it('passes quantity correctly', async () => {
            const { executeBuyOrder } = await import('../order');
            mockFetch.mockResolvedValueOnce(
                mockResponse({ orderId: 'ORD-003', status: 'submitted' }),
            );

            await executeBuyOrder('035720', 250);

            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.quantity).toBe(250);
        });
    });

    describe('executeSellOrder', () => {
        it('delegates to submitOrder with side=sell and orderType=market', async () => {
            const { executeSellOrder } = await import('../order');
            const expectedResponse: TossOrderResponse = {
                orderId: 'ORD-SELL-001',
                status: 'filled',
                filledPrice: 72000,
                filledQuantity: 5,
            };
            mockFetch.mockResolvedValueOnce(mockResponse(expectedResponse));

            const result = await executeSellOrder('005930', 5);

            expect(result).toEqual(expectedResponse);
            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.side).toBe('sell');
            expect(body.orderType).toBe('market');
            expect(body.symbol).toBe('005930');
            expect(body.quantity).toBe(5);
        });

        it('passes quantity correctly', async () => {
            const { executeSellOrder } = await import('../order');
            mockFetch.mockResolvedValueOnce(
                mockResponse({ orderId: 'ORD-004', status: 'submitted' }),
            );

            await executeSellOrder('035720', 75);

            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.quantity).toBe(75);
        });
    });
});
