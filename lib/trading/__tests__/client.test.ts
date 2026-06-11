import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TossApiError } from '../client';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { mockGetAccessToken, mockForceRefreshToken } = vi.hoisted(() => ({
    mockGetAccessToken: vi.fn(async (): Promise<string> => 'tok-abc'),
    mockForceRefreshToken: vi.fn(async (_staleToken?: string): Promise<string> => 'tok-refreshed'),
}));
vi.mock('../token', () => ({
    getAccessToken: mockGetAccessToken,
    forceRefreshToken: mockForceRefreshToken,
}));

function res(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => headers[k] ?? null },
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
        json: () => Promise.resolve(body),
    } as unknown as Response;
}

describe('tossFetch', () => {
    beforeEach(() => {
        vi.resetModules();
        mockFetch.mockReset();
        mockGetAccessToken.mockClear();
        mockGetAccessToken.mockResolvedValue('tok-abc');
        mockForceRefreshToken.mockClear();
        mockForceRefreshToken.mockResolvedValue('tok-refreshed');
        // Ensure Redis is NOT configured so resolveAccountSeq hits the /accounts API path deterministically.
        vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
        vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    it('성공 시 ApiResponse envelope에서 result 언랩', async () => {
        mockFetch.mockResolvedValueOnce(res({ result: { foo: 'bar' } }));
        const { tossFetch } = await import('../client');
        const out = await tossFetch('GET', '/api/v1/test');
        expect(out).toEqual({ foo: 'bar' });
    });

    it('Authorization Bearer 토큰 주입', async () => {
        mockFetch.mockResolvedValueOnce(res({ result: {} }));
        const { tossFetch } = await import('../client');
        await tossFetch('GET', '/api/v1/test');
        const [, opts] = mockFetch.mock.calls[0];
        expect(opts.headers.Authorization).toBe('Bearer tok-abc');
    });

    it('account:true면 X-Tossinvest-Account 헤더 부착 (accountSeq 조회)', async () => {
        mockFetch
            .mockResolvedValueOnce(
                res({ result: [{ accountNo: '1', accountSeq: 7, accountType: 'BROKERAGE' }] }),
            )
            .mockResolvedValueOnce(res({ result: { ok: true } }));
        const { tossFetch } = await import('../client');
        await tossFetch('GET', '/api/v1/holdings', { account: true });
        const [, opts] = mockFetch.mock.calls[1];
        expect(opts.headers['X-Tossinvest-Account']).toBe('7');
    });

    it('query 파라미터를 URL에 직렬화', async () => {
        mockFetch.mockResolvedValueOnce(res({ result: [] }));
        const { tossFetch } = await import('../client');
        await tossFetch('GET', '/api/v1/prices', { query: { symbols: 'AAPL,MSFT' } });
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain('symbols=AAPL%2CMSFT');
    });

    it('worst: 4xx 에러를 TossApiError(code 보존)로 throw', async () => {
        mockFetch.mockResolvedValueOnce(
            res(
                { error: { code: 'insufficient-buying-power', message: '부족', requestId: 'r1' } },
                422,
            ),
        );
        const { tossFetch, TossApiError } = await import('../client');
        const err = (await tossFetch('POST', '/api/v1/orders', { body: {} }).catch(
            (e) => e,
        )) as TossApiError;
        expect(err).toBeInstanceOf(TossApiError);
        expect(err.code).toBe('insufficient-buying-power');
        expect(err.status).toBe(422);
    });

    it('worst: 401이면 토큰 강제 재발급(실패한 토큰 전달) 후 1회 재시도', async () => {
        mockFetch
            .mockResolvedValueOnce(res({ error: { code: 'unauthorized' } }, 401))
            .mockResolvedValueOnce(res({ result: { ok: 1 } }));
        const { tossFetch } = await import('../client');
        const out = await tossFetch('GET', '/api/v1/test');
        expect(out).toEqual({ ok: 1 });
        expect(mockForceRefreshToken).toHaveBeenCalledOnce();
        // 실패한(stale) 토큰을 인자로 전달했는지 확인
        expect(mockForceRefreshToken).toHaveBeenCalledWith('tok-abc');
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('worst: GET 5xx는 2회 재시도 후 성공', async () => {
        vi.useFakeTimers();
        mockFetch
            .mockResolvedValueOnce(res('err', 500))
            .mockResolvedValueOnce(res({ result: { ok: 1 } }));
        const { tossFetch } = await import('../client');
        const p = tossFetch('GET', '/api/v1/test');
        await vi.runAllTimersAsync();
        expect(await p).toEqual({ ok: 1 });
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('worst: GET 5xx 지속 시 최종 throw', async () => {
        vi.useFakeTimers();
        mockFetch
            .mockResolvedValueOnce(res('err', 500))
            .mockResolvedValueOnce(res('err', 502))
            .mockResolvedValueOnce(res('err', 503));
        const { tossFetch } = await import('../client');
        const p = tossFetch('GET', '/api/v1/test');
        const assertion = expect(p).rejects.toThrow();
        await vi.runAllTimersAsync();
        await assertion;
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('worst: POST는 clientOrderId 없으면 5xx에서 재시도 금지', async () => {
        mockFetch.mockResolvedValueOnce(res('err', 500));
        const { tossFetch } = await import('../client');
        await expect(
            tossFetch('POST', '/api/v1/orders', { body: { symbol: 'A' } }),
        ).rejects.toThrow();
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('worst: POST에 clientOrderId 있으면 5xx 재시도 허용(멱등)', async () => {
        vi.useFakeTimers();
        mockFetch
            .mockResolvedValueOnce(res('err', 500))
            .mockResolvedValueOnce(res({ result: { orderId: 'o1' } }));
        const { tossFetch } = await import('../client');
        const p = tossFetch('POST', '/api/v1/orders', {
            body: { clientOrderId: 'co-1', symbol: 'A' },
        });
        await vi.runAllTimersAsync();
        expect(await p).toEqual({ orderId: 'o1' });
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('worst: 429는 Retry-After 존중 후 재시도', async () => {
        vi.useFakeTimers();
        mockFetch
            .mockResolvedValueOnce(
                res({ error: { code: 'rate-limited' } }, 429, { 'Retry-After': '0' }),
            )
            .mockResolvedValueOnce(res({ result: { ok: 1 } }));
        const { tossFetch } = await import('../client');
        const p = tossFetch('GET', '/api/v1/test');
        await vi.runAllTimersAsync();
        expect(await p).toEqual({ ok: 1 });
    });

    it('worst: 409 request-in-progress 재시도', async () => {
        vi.useFakeTimers();
        mockFetch
            .mockResolvedValueOnce(res({ error: { code: 'request-in-progress' } }, 409))
            .mockResolvedValueOnce(res({ result: { orderId: 'o1' } }));
        const { tossFetch } = await import('../client');
        const p = tossFetch('POST', '/api/v1/orders', { body: { clientOrderId: 'c1' } });
        await vi.runAllTimersAsync();
        expect(await p).toEqual({ orderId: 'o1' });
    });

    it('worst: 409 idempotency-key-conflict는 재시도 없이 throw', async () => {
        mockFetch.mockResolvedValueOnce(res({ error: { code: 'idempotency-key-conflict' } }, 409));
        const { tossFetch, TossApiError } = await import('../client');
        const err = (await tossFetch('POST', '/api/v1/orders', {
            body: { clientOrderId: 'c1' },
        }).catch((e) => e)) as TossApiError;
        expect(err).toBeInstanceOf(TossApiError);
        expect(err.code).toBe('idempotency-key-conflict');
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('worst: 비JSON 바디 5xx는 TossApiError(code=http-500)로 throw', async () => {
        mockFetch.mockResolvedValueOnce(res('Internal Server Error', 500));
        const { tossFetch, TossApiError } = await import('../client');
        const err = (await tossFetch('POST', '/api/v1/orders', { body: { symbol: 'A' } }).catch(
            (e) => e,
        )) as TossApiError;
        expect(err).toBeInstanceOf(TossApiError);
        expect(err.code).toBe('http-500');
    });

    it('exhausted: 401 두 번 연속 시 TossApiError throw (triedRefresh 방어)', async () => {
        // 첫 번째 401 → forceRefresh → 두 번째 401 → throw (재시도 소진)
        mockFetch
            .mockResolvedValueOnce(res({ error: { code: 'unauthorized' } }, 401))
            .mockResolvedValueOnce(res({ error: { code: 'unauthorized' } }, 401));
        const { tossFetch, TossApiError } = await import('../client');
        const err = (await tossFetch('GET', '/api/v1/test').catch((e) => e)) as TossApiError;
        expect(err).toBeInstanceOf(TossApiError);
        expect(mockForceRefreshToken).toHaveBeenCalledOnce();
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('exhausted: 최종 재시도 소진 후 exhausted TossApiError throw (5xx GET 3회 연속)', async () => {
        vi.useFakeTimers();
        // attempt=0 → 500, attempt=1 → 500, attempt=2 → 500: 모두 retried, exhausted throw
        mockFetch
            .mockResolvedValueOnce(res('err', 500))
            .mockResolvedValueOnce(res('err', 500))
            .mockResolvedValueOnce(res('err', 500));
        const { tossFetch, TossApiError } = await import('../client');
        const p = tossFetch('GET', '/api/v1/test');
        const assertion = expect(p).rejects.toBeInstanceOf(TossApiError);
        await vi.runAllTimersAsync();
        await assertion;
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('result 없는 응답은 json 전체를 반환', async () => {
        // result 키가 없는 응답 → json itself returned
        mockFetch.mockResolvedValueOnce(res({ items: [1, 2, 3] }));
        const { tossFetch } = await import('../client');
        const out = await tossFetch('GET', '/api/v1/test');
        expect(out).toEqual({ items: [1, 2, 3] });
    });

    it('worst: 429에 Retry-After 헤더 없으면 기본 딜레이로 재시도', async () => {
        vi.useFakeTimers();
        mockFetch
            .mockResolvedValueOnce(res({ error: { code: 'rate-limited' } }, 429))
            .mockResolvedValueOnce(res({ result: { ok: 1 } }));
        const { tossFetch } = await import('../client');
        const p = tossFetch('GET', '/api/v1/test');
        await vi.runAllTimersAsync();
        expect(await p).toEqual({ ok: 1 });
    });

    it('worst: 429 Retry-After가 NaN이면 기본 딜레이(BASE_DELAY_MS) 사용', async () => {
        vi.useFakeTimers();
        mockFetch
            .mockResolvedValueOnce(
                res({ error: { code: 'rate-limited' } }, 429, { 'Retry-After': 'not-a-number' }),
            )
            .mockResolvedValueOnce(res({ result: { ok: 1 } }));
        const { tossFetch } = await import('../client');
        const p = tossFetch('GET', '/api/v1/test');
        await vi.runAllTimersAsync();
        expect(await p).toEqual({ ok: 1 });
    });

    it('fix(issue-1): 401 재발급 후 5xx 2회 → 총 4회 fetch, forceRefreshToken 1회, 최종 성공', async () => {
        vi.useFakeTimers();
        mockFetch
            .mockResolvedValueOnce(res({ error: { code: 'unauthorized' } }, 401)) // attempt 0 → 401
            .mockResolvedValueOnce(res('err', 500)) // attempt 0 (after refresh) → 500
            .mockResolvedValueOnce(res('err', 500)) // attempt 1 → 500
            .mockResolvedValueOnce(res({ result: { ok: 1 } })); // attempt 2 → success
        const { tossFetch } = await import('../client');
        const p = tossFetch('GET', '/api/v1/test');
        const assertion = expect(p).resolves.toEqual({ ok: 1 });
        await vi.runAllTimersAsync();
        await assertion;
        expect(mockForceRefreshToken).toHaveBeenCalledOnce();
        expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('fix(issue-3): 429 Retry-After가 음수(-5)이면 0으로 클램프 후 재시도 성공', async () => {
        vi.useFakeTimers();
        mockFetch
            .mockResolvedValueOnce(
                res({ error: { code: 'rate-limited' } }, 429, { 'Retry-After': '-5' }),
            )
            .mockResolvedValueOnce(res({ result: { ok: 1 } }));
        const { tossFetch } = await import('../client');
        const p = tossFetch('GET', '/api/v1/test');
        await vi.runAllTimersAsync();
        expect(await p).toEqual({ ok: 1 });
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('parseError: error 객체에 code 없고 message도 없으면 fallback 사용', async () => {
        // error is an object but has neither code, message — test fallback branches
        mockFetch.mockResolvedValueOnce(res({ error: { requestId: 'r1' } }, 400));
        const { tossFetch, TossApiError } = await import('../client');
        const err = (await tossFetch('GET', '/api/v1/test').catch((e) => e)) as TossApiError;
        expect(err).toBeInstanceOf(TossApiError);
        // code falls back to http-400 since no .code or .error
        expect(err.code).toBe('http-400');
    });

    it('account:true + BROKERAGE 계좌 없으면 첫 번째 계좌 사용', async () => {
        mockFetch
            .mockResolvedValueOnce(
                res({ result: [{ accountNo: '1', accountSeq: 99, accountType: 'ISA' }] }),
            )
            .mockResolvedValueOnce(res({ result: { ok: true } }));
        const { tossFetch } = await import('../client');
        await tossFetch('GET', '/api/v1/holdings', { account: true });
        const [, opts] = mockFetch.mock.calls[1];
        expect(opts.headers['X-Tossinvest-Account']).toBe('99');
    });

    it('account:true + 계좌 없으면 에러 throw', async () => {
        mockFetch.mockResolvedValueOnce(res({ result: [] }));
        const { tossFetch } = await import('../client');
        await expect(tossFetch('GET', '/api/v1/holdings', { account: true })).rejects.toThrow(
            'No Toss account found',
        );
    });

    it('resolveAccountSeq: Redis 캐시 히트 시 accounts API 호출 생략', async () => {
        // Redis가 설정된 것처럼 env 세팅 후 Redis mock 주입
        vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://fake.upstash.io');
        vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'fake-token');

        const mockRedisGet = vi.fn().mockResolvedValue(42);
        vi.doMock('@upstash/redis', () => ({
            Redis: vi.fn().mockImplementation(() => ({
                get: mockRedisGet,
                set: vi.fn(),
            })),
        }));

        const { resolveAccountSeq } = await import('../client');
        const seq = await resolveAccountSeq();
        expect(seq).toBe(42);
        // accounts API should NOT be called
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
