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

// lock 모킹 — 기본값: 락 획득 성공 (token string) → 기존 테스트 유지
vi.mock('../../lock', () => ({
    acquireLock: vi.fn(async () => 'test-refresh-lock-token'),
    releaseLock: vi.fn(async () => {}),
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
        mockGet.mockReset().mockImplementation(async (k: string) => redisStore.get(k) ?? null);
        mockSet.mockReset().mockImplementation(async (k: string, v: string) => {
            redisStore.set(k, v);
            return 'OK';
        });
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

    it('forceRefreshToken(no-arg)은 캐시 무시하고 재발급', async () => {
        redisStore.set('toss:oauth:token', 'old-tok');
        mockFetch.mockResolvedValueOnce(
            tokenResponse({ access_token: 'new-tok', token_type: 'Bearer', expires_in: 100 }),
        );
        const lockMod = await import('../../lock');
        vi.mocked(lockMod.acquireLock).mockResolvedValueOnce('refresh-lock-token');
        const { forceRefreshToken } = await import('../token');
        const token = await forceRefreshToken();
        expect(token).toBe('new-tok');
        expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('worst: Redis 미설정(dev)이면 토큰 메모이제이션 — 두 번 호출 시 fetch 1회만', async () => {
        vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
        vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
        const devTokenResp = tokenResponse({
            access_token: 'dev-tok',
            token_type: 'Bearer',
            expires_in: 3600,
        });
        mockFetch.mockResolvedValue(devTokenResp);
        const { getAccessToken } = await import('../token');
        const first = await getAccessToken();
        const second = await getAccessToken();
        expect(first).toBe('dev-tok');
        expect(second).toBe('dev-tok');
        // 메모이제이션: fetch는 딱 1번만 호출
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('worst: dev forceRefreshToken()은 메모 초기화 후 재발급', async () => {
        vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
        vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
        mockFetch.mockResolvedValue(
            tokenResponse({ access_token: 'dev-tok', token_type: 'Bearer', expires_in: 3600 }),
        );
        const { getAccessToken, forceRefreshToken } = await import('../token');
        // 1차 발급 (fetch #1)
        await getAccessToken();
        // 메모 히트 (fetch 추가 없음)
        await getAccessToken();
        expect(mockFetch).toHaveBeenCalledTimes(1);
        // forceRefreshToken → 메모 초기화 후 재발급 (fetch #2)
        await forceRefreshToken();
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('worst: expires_in 누락 시 기본값 86400 - 60 = 86340으로 캐싱', async () => {
        mockFetch.mockResolvedValueOnce(
            tokenResponse({ access_token: 'tok-noexp', token_type: 'Bearer' }),
        );
        const { getAccessToken } = await import('../token');
        const token = await getAccessToken();
        expect(token).toBe('tok-noexp');
        expect(mockSet).toHaveBeenCalledWith(
            'toss:oauth:token',
            'tok-noexp',
            expect.objectContaining({ ex: 86340 }),
        );
    });

    it('worst: expires_in이 비정상값(NaN)일 때 기본값 86340으로 캐싱', async () => {
        mockFetch.mockResolvedValueOnce(
            tokenResponse({ access_token: 'tok-nan', token_type: 'Bearer', expires_in: NaN }),
        );
        const { getAccessToken } = await import('../token');
        const token = await getAccessToken();
        expect(token).toBe('tok-nan');
        expect(mockSet).toHaveBeenCalledWith(
            'toss:oauth:token',
            'tok-nan',
            expect.objectContaining({ ex: 86340 }),
        );
    });

    it('worst: 자격증명 누락 시 에러', async () => {
        vi.stubEnv('TOSS_APP_KEY', '');
        const { getAccessToken } = await import('../token');
        await expect(getAccessToken()).rejects.toThrow(/TOSS_APP_KEY/);
    });

    it('worst: 락 경합 — 폴링 중 캐시 등장 시 새 발급 없이 캐시 토큰 반환', async () => {
        // 초기 캐시 미스 → 락 획득 실패 → 폴링 중 캐시 등장
        mockGet
            .mockResolvedValueOnce(null) // 최초 캐시 확인: 미스
            .mockResolvedValue('polled-tok'); // 폴링 시 캐시 히트
        const lockMod = await import('../../lock');
        vi.mocked(lockMod.acquireLock).mockResolvedValueOnce(null);

        vi.useFakeTimers();
        try {
            const { getAccessToken } = await import('../token');
            const p = getAccessToken();
            await vi.runAllTimersAsync();
            const result = await p;

            expect(result).toBe('polled-tok');
            expect(mockFetch).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('worst: 락 경합 — 폴링 내내 캐시 없음 → MAX_WAIT_MS 후 throw', async () => {
        // 초기 캐시 미스 → 락 획득 계속 실패 → 폴링 전체 캐시 미스 → 타임아웃 throw
        mockGet.mockResolvedValue(null);
        const lockMod = await import('../../lock');
        vi.mocked(lockMod.acquireLock).mockResolvedValue(null);

        vi.useFakeTimers();
        try {
            const { getAccessToken } = await import('../token');
            const p = getAccessToken();
            const assertion = expect(p).rejects.toThrow(/timed out waiting for lock/);
            await vi.runAllTimersAsync();
            await assertion;
            expect(mockFetch).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('forceRefreshToken(staleToken) — 캐시가 staleToken과 다르면 재발급 없이 캐시 반환', async () => {
        redisStore.set('toss:oauth:token', 'fresh-Y');
        const lockMod = await import('../../lock');
        vi.mocked(lockMod.acquireLock).mockResolvedValueOnce('refresh-lock-token');
        const { forceRefreshToken } = await import('../token');
        const result = await forceRefreshToken('stale-X');
        expect(result).toBe('fresh-Y');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('forceRefreshToken(staleToken) — 캐시가 staleToken과 같으면 재발급', async () => {
        redisStore.set('toss:oauth:token', 'stale-X');
        mockFetch.mockResolvedValueOnce(
            tokenResponse({ access_token: 'brand-new', token_type: 'Bearer', expires_in: 100 }),
        );
        const lockMod = await import('../../lock');
        vi.mocked(lockMod.acquireLock).mockResolvedValueOnce('refresh-lock-token');
        const { forceRefreshToken } = await import('../token');
        const result = await forceRefreshToken('stale-X');
        expect(result).toBe('brand-new');
        expect(mockFetch).toHaveBeenCalledOnce();
    });
});
