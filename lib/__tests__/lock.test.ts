import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @upstash/redis
// ---------------------------------------------------------------------------

const mockSet = vi.fn();
const mockDel = vi.fn();
const mockEval = vi.fn();

vi.mock('@upstash/redis', () => ({
    Redis: vi.fn().mockImplementation(() => ({
        set: mockSet,
        del: mockDel,
        eval: mockEval,
    })),
}));

// Note: all tests use vi.resetModules() + fresh import('../lock') to avoid
// cached Redis singleton state between tests.

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lock', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        // Clean up env vars to reset the lazy-init singleton between tests
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
    });

    describe('acquireLock', () => {
        it('returns a synthetic dev token (truthy string) when Redis is not configured (dev mode)', async () => {
            // No UPSTASH env vars set
            delete process.env.UPSTASH_REDIS_REST_URL;
            delete process.env.UPSTASH_REDIS_REST_TOKEN;

            // Re-import to get a fresh module with no cached Redis instance
            vi.resetModules();
            const { acquireLock: freshAcquire } = await import('../lock');

            const result = await freshAcquire('test:lock');

            expect(result).toBeTypeOf('string');
            expect(result).toBeTruthy();
            expect(mockSet).not.toHaveBeenCalled();
        });

        it('returns null (fail-CLOSED) when Redis is not configured in production (NODE_ENV=production)', async () => {
            delete process.env.UPSTASH_REDIS_REST_URL;
            delete process.env.UPSTASH_REDIS_REST_TOKEN;

            vi.resetModules();
            vi.stubEnv('NODE_ENV', 'production');
            const { acquireLock: freshAcquire } = await import('../lock');

            const result = await freshAcquire('test:lock');

            expect(result).toBeNull();
            expect(mockSet).not.toHaveBeenCalled();
            vi.unstubAllEnvs();
        });

        it('returns null (fail-CLOSED) when Redis is not configured in production (VERCEL_ENV=production)', async () => {
            delete process.env.UPSTASH_REDIS_REST_URL;
            delete process.env.UPSTASH_REDIS_REST_TOKEN;

            vi.resetModules();
            vi.stubEnv('VERCEL_ENV', 'production');
            const { acquireLock: freshAcquire } = await import('../lock');

            const result = await freshAcquire('test:lock');

            expect(result).toBeNull();
            expect(mockSet).not.toHaveBeenCalled();
            vi.unstubAllEnvs();
        });

        it('returns a token string when SETNX succeeds (lock acquired)', async () => {
            vi.resetModules();
            process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

            const { acquireLock: freshAcquire } = await import('../lock');
            mockSet.mockResolvedValue('OK');

            const result = await freshAcquire('cron:execute:lock');

            expect(result).toBeTypeOf('string');
            expect(result).toBeTruthy();
            expect(mockSet).toHaveBeenCalledWith('cron:execute:lock', expect.any(String), {
                nx: true,
                ex: 900,
            });
            // The returned token must match the UUID passed to Redis
            const passedUuid = mockSet.mock.calls[0]?.[1];
            expect(result).toBe(passedUuid);
        });

        it('returns null when SETNX fails (lock already held)', async () => {
            vi.resetModules();
            process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

            const { acquireLock: freshAcquire } = await import('../lock');
            mockSet.mockResolvedValue(null);

            const result = await freshAcquire('cron:execute:lock');

            expect(result).toBeNull();
        });

        it('returns null when Redis throws an error (fail closed)', async () => {
            vi.resetModules();
            process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

            const { acquireLock: freshAcquire } = await import('../lock');
            mockSet.mockRejectedValue(new Error('Connection refused'));

            const result = await freshAcquire('cron:execute:lock');

            expect(result).toBeNull();
        });

        it('respects custom TTL', async () => {
            vi.resetModules();
            process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

            const { acquireLock: freshAcquire } = await import('../lock');
            mockSet.mockResolvedValue('OK');

            await freshAcquire('test:lock', 60);

            expect(mockSet).toHaveBeenCalledWith('test:lock', expect.any(String), {
                nx: true,
                ex: 60,
            });
        });
    });

    describe('releaseLock', () => {
        it('does nothing when Redis is not configured', async () => {
            vi.resetModules();
            delete process.env.UPSTASH_REDIS_REST_URL;
            delete process.env.UPSTASH_REDIS_REST_TOKEN;

            const { releaseLock: freshRelease } = await import('../lock');

            await freshRelease('test:lock', 'some-token');

            expect(mockEval).not.toHaveBeenCalled();
            expect(mockDel).not.toHaveBeenCalled();
        });

        it('does nothing when token is null', async () => {
            vi.resetModules();
            process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

            const { releaseLock: freshRelease } = await import('../lock');

            await freshRelease('test:lock', null);

            expect(mockEval).not.toHaveBeenCalled();
            expect(mockDel).not.toHaveBeenCalled();
        });

        it('does nothing when token is undefined', async () => {
            vi.resetModules();
            process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

            const { releaseLock: freshRelease } = await import('../lock');

            await freshRelease('test:lock', undefined);

            expect(mockEval).not.toHaveBeenCalled();
            expect(mockDel).not.toHaveBeenCalled();
        });

        it('releases lock with Lua compare-and-delete script using the provided token', async () => {
            vi.resetModules();
            process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

            const { acquireLock: freshAcquire, releaseLock: freshRelease } =
                await import('../lock');
            mockSet.mockResolvedValue('OK');
            mockEval.mockResolvedValue(1);

            // Acquire returns the token; pass it explicitly to release
            const token = await freshAcquire('cron:execute:lock');
            expect(token).toBeTruthy();

            await freshRelease('cron:execute:lock', token);

            expect(mockEval).toHaveBeenCalledWith(
                expect.stringContaining('redis.call("get", KEYS[1])'),
                ['cron:execute:lock'],
                [token],
            );
        });

        it('release with wrong token does not match the stored value (Lua returns 0)', async () => {
            vi.resetModules();
            process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

            const { releaseLock: freshRelease } = await import('../lock');
            mockEval.mockResolvedValue(0); // Lua: values don't match, nothing deleted

            // Release with a wrong/arbitrary token — should call eval but Lua no-ops
            await freshRelease('cron:execute:lock', 'wrong-token');

            expect(mockEval).toHaveBeenCalledWith(
                expect.stringContaining('redis.call("get", KEYS[1])'),
                ['cron:execute:lock'],
                ['wrong-token'],
            );
        });

        it('does not throw when Redis errors during release', async () => {
            vi.resetModules();
            process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

            const { acquireLock: freshAcquire, releaseLock: freshRelease } =
                await import('../lock');
            mockSet.mockResolvedValue('OK');
            mockEval.mockRejectedValue(new Error('Connection lost'));

            const token = await freshAcquire('cron:execute:lock');
            // Should not throw even though eval fails
            await expect(freshRelease('cron:execute:lock', token)).resolves.toBeUndefined();
        });

        it('is a no-op when token is null (lock was never acquired)', async () => {
            vi.resetModules();
            process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

            const { releaseLock: freshRelease } = await import('../lock');

            // Passing null simulates calling releaseLock after acquireLock returned null
            await freshRelease('cron:execute:lock', null);

            // Should not attempt to delete — no token provided
            expect(mockEval).not.toHaveBeenCalled();
            expect(mockDel).not.toHaveBeenCalled();
        });
    });
});
