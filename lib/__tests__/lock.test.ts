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

// Import AFTER mocks are set up
const { acquireLock, releaseLock } = await import('../lock');

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
        it('returns true when Redis is not configured (dev mode)', async () => {
            // No UPSTASH env vars set
            delete process.env.UPSTASH_REDIS_REST_URL;
            delete process.env.UPSTASH_REDIS_REST_TOKEN;

            // Re-import to get a fresh module with no cached Redis instance
            vi.resetModules();
            const { acquireLock: freshAcquire } = await import('../lock');

            const result = await freshAcquire('test:lock');

            expect(result).toBe(true);
            expect(mockSet).not.toHaveBeenCalled();
        });

        it('returns true when SETNX succeeds (lock acquired)', async () => {
            vi.resetModules();
            process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

            const { acquireLock: freshAcquire } = await import('../lock');
            mockSet.mockResolvedValue('OK');

            const result = await freshAcquire('cron:execute:lock');

            expect(result).toBe(true);
            expect(mockSet).toHaveBeenCalledWith('cron:execute:lock', expect.any(String), {
                nx: true,
                ex: 900,
            });
        });

        it('returns false when SETNX fails (lock already held)', async () => {
            vi.resetModules();
            process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

            const { acquireLock: freshAcquire } = await import('../lock');
            mockSet.mockResolvedValue(null);

            const result = await freshAcquire('cron:execute:lock');

            expect(result).toBe(false);
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

            await freshRelease('test:lock');

            expect(mockEval).not.toHaveBeenCalled();
            expect(mockDel).not.toHaveBeenCalled();
        });

        it('releases lock with Lua script after successful acquire', async () => {
            vi.resetModules();
            process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

            const { acquireLock: freshAcquire, releaseLock: freshRelease } =
                await import('../lock');
            mockSet.mockResolvedValue('OK');
            mockEval.mockResolvedValue(1);

            // Must acquire first so the owner UUID is stored
            await freshAcquire('cron:execute:lock');
            await freshRelease('cron:execute:lock');

            expect(mockEval).toHaveBeenCalledWith(
                expect.stringContaining('redis.call("get", KEYS[1])'),
                ['cron:execute:lock'],
                [expect.any(String)],
            );
        });

        it('does nothing if lock was never acquired (no owner value)', async () => {
            vi.resetModules();
            process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

            const { releaseLock: freshRelease } = await import('../lock');

            await freshRelease('cron:execute:lock');

            // Should not attempt to delete — no owner UUID exists
            expect(mockEval).not.toHaveBeenCalled();
            expect(mockDel).not.toHaveBeenCalled();
        });
    });
});
