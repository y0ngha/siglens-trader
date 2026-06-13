import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';

let redis: Redis | null = null;

function getRedis(): Redis | null {
    if (redis) return redis;
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    redis = new Redis({ url, token });
    return redis;
}

const DEFAULT_LOCK_TTL_SECONDS = 900; // 15 minutes

/**
 * Attempt to acquire a distributed lock via Redis SETNX.
 *
 * Returns the owner token string on success, or null if the lock is already held,
 * Redis is unavailable in production (fail-closed), or a Redis error occurs.
 *
 * The caller must pass the returned token to releaseLock — the token is NOT stored
 * in module-level state, making this safe across serverless function invocations
 * where separate instances share no in-process memory.
 */
export async function acquireLock(
    key: string,
    ttlSeconds = DEFAULT_LOCK_TTL_SECONDS,
): Promise<string | null> {
    const r = getRedis();
    if (!r) {
        const isProd =
            process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
        if (isProd) {
            console.error(
                '[lock] Redis not configured in production — failing CLOSED (refusing lock) to prevent unlocked concurrent execution',
            );
            return null;
        }
        console.warn('[lock] Redis not configured — lock disabled (dev mode)');
        // In dev mode return a synthetic token so callers can proceed without Redis.
        return `dev-${crypto.randomUUID()}`;
    }
    try {
        const value = crypto.randomUUID();
        const result = await r.set(key, value, { nx: true, ex: ttlSeconds });
        if (result === 'OK') {
            return value;
        }
        return null;
    } catch (err) {
        console.error('[lock] Redis error during acquireLock:', err);
        return null; // Fail closed — don't execute without lock
    }
}

/**
 * Release a distributed lock using a Lua compare-and-delete script.
 *
 * Only deletes the Redis key if its stored value matches the provided token,
 * preventing a timed-out lock from being released by a later invocation that
 * re-acquired it with a different token.
 *
 * If token is null/undefined (e.g. lock was never acquired), this is a no-op.
 */
export async function releaseLock(key: string, token: string | null | undefined): Promise<void> {
    const r = getRedis();
    if (!r) return;
    if (!token) return;
    try {
        // Atomic check-and-delete via Lua script to prevent releasing another owner's lock
        const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
        await r.eval(script, [key], [token]);
    } catch (err) {
        console.error('[lock] Redis error during releaseLock:', err);
    }
}
