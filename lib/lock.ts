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
 * In-memory map of lock keys to their owner UUIDs.
 * Used to ensure only the process that acquired the lock can release it.
 */
const lockValues = new Map<string, string>();

export async function acquireLock(
    key: string,
    ttlSeconds = DEFAULT_LOCK_TTL_SECONDS,
): Promise<boolean> {
    const r = getRedis();
    if (!r) {
        console.warn('[lock] Redis not configured — lock disabled (dev mode)');
        return true;
    }
    try {
        const value = crypto.randomUUID();
        const result = await r.set(key, value, { nx: true, ex: ttlSeconds });
        if (result === 'OK') {
            lockValues.set(key, value);
            return true;
        }
        return false;
    } catch (err) {
        console.error('[lock] Redis error during acquireLock:', err);
        return false; // Fail closed — don't execute without lock
    }
}

export async function releaseLock(key: string): Promise<void> {
    const r = getRedis();
    if (!r) return;
    const expectedValue = lockValues.get(key);
    if (!expectedValue) return;
    try {
        // Atomic check-and-delete via Lua script to prevent releasing another owner's lock
        const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
        await r.eval(script, [key], [expectedValue]);
    } catch (err) {
        console.error('[lock] Redis error during releaseLock:', err);
    }
    lockValues.delete(key);
}
