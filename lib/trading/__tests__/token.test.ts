import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Redis 모킹
const redisStore = new Map<string, string>();
const mockGet = vi.fn(async (k: string) => redisStore.get(k) ?? null);
const mockSet = vi.fn(async (k: string, v: string) => {
    redisStore.set(k, v);
    return 'OK';
});
vi.mock('@upstash/redis', () => ({
    Redis: vi.fn(() => ({ get: mockGet, set: mockSet, eval: vi.fn(async () => 1) })),
}));

function tokenResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
        json: () => Promise.resolve(body),
    } as Response;
}

describe('token manager', () => {
    beforeEach(() => {
        vi.resetModules();
        redisStore.clear();
        mockFetch.mockReset();
        mockGet.mockClear();
        mockSet.mockClear();
        vi.stubEnv('TOSS_APP_KEY', 'c_test');
        vi.stubEnv('TOSS_SECRET_KEY', 's_test');
        vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.test');
        vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-token');
    });
    afterEach(() => vi.unstubAllEnvs());

    it('발급 성공 시 access_token 반환 + form-urlencoded 전송', async () => {
        mockFetch.mockResolvedValueOnce(
            tokenResponse({ access_token: 'tok-1', token_type: 'Bearer', expires_in: 86400 }),
        );
        const { getAccessToken } = await import('../token');
        const token = await getAccessToken();

        expect(token).toBe('tok-1');
        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toBe('https://openapi.tossinvest.com/oauth2/token');
        expect(opts.method).toBe('POST');
        expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        expect(opts.body).toContain('grant_type=client_credentials');
        expect(opts.body).toContain('client_id=c_test');
        expect(opts.body).toContain('client_secret=s_test');
    });

    it('Redis 캐시 히트 시 재발급하지 않음', async () => {
        redisStore.set('toss:oauth:token', 'cached-tok');
        const { getAccessToken } = await import('../token');
        const token = await getAccessToken();
        expect(token).toBe('cached-tok');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('발급 후 만료 여유(60s) 차감한 TTL로 캐싱', async () => {
        mockFetch.mockResolvedValueOnce(
            tokenResponse({ access_token: 'tok-2', token_type: 'Bearer', expires_in: 86400 }),
        );
        const { getAccessToken } = await import('../token');
        await getAccessToken();
        expect(mockSet).toHaveBeenCalledWith(
            'toss:oauth:token',
            'tok-2',
            expect.objectContaining({ ex: 86340 }),
        );
    });

    it('worst: 401 invalid_client 응답 시 에러 throw', async () => {
        mockFetch.mockResolvedValueOnce(
            tokenResponse({ error: 'invalid_client', error_description: 'fail' }, 401),
        );
        const { getAccessToken } = await import('../token');
        await expect(getAccessToken()).rejects.toThrow(/invalid_client/);
    });

    it('worst: 네트워크 실패 전파', async () => {
        mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
        const { getAccessToken } = await import('../token');
        await expect(getAccessToken()).rejects.toThrow('fetch failed');
    });

    it('forceRefreshToken은 캐시 무시하고 재발급', async () => {
        redisStore.set('toss:oauth:token', 'old-tok');
        mockFetch.mockResolvedValueOnce(
            tokenResponse({ access_token: 'new-tok', token_type: 'Bearer', expires_in: 100 }),
        );
        const { forceRefreshToken } = await import('../token');
        const token = await forceRefreshToken();
        expect(token).toBe('new-tok');
        expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('worst: Redis 미설정(dev)이면 매번 직접 발급', async () => {
        vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
        vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
        mockFetch.mockResolvedValue(
            tokenResponse({ access_token: 'dev-tok', token_type: 'Bearer', expires_in: 100 }),
        );
        const { getAccessToken } = await import('../token');
        expect(await getAccessToken()).toBe('dev-tok');
    });

    it('worst: 자격증명 누락 시 에러', async () => {
        vi.stubEnv('TOSS_APP_KEY', '');
        const { getAccessToken } = await import('../token');
        await expect(getAccessToken()).rejects.toThrow(/TOSS_APP_KEY/);
    });
});
