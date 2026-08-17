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
    return (await acquireLockDetailed(key, ttlSeconds)).token;
}

/**
 * 락 획득 결과. **경합과 장애를 구분한다.**
 *
 * 둘 다 `null`을 돌려주면 크론은 양쪽 모두 `skipped`/`locked`로 기록하는데, 그 둘은
 * 전혀 다른 사건이다: 경합은 정상(다른 실행이 돌고 있다)이고, Redis 장애는 **모든
 * 크론이 한 틱도 돌지 않는 전면 정지**다. 후자를 `skipped`로 남기면 침묵을 감시하는
 * `assessCronHealth`(status === 'error'만 실패로 센다)가 아무 경보도 내지 않아,
 * 장중 내내 분석도 청산도 없이 지나갈 수 있다.
 */
export type LockAcquisition =
    | { token: string; reason?: undefined }
    | { token: null; reason: 'contended' | 'unavailable' };

export async function acquireLockDetailed(
    key: string,
    ttlSeconds = DEFAULT_LOCK_TTL_SECONDS,
): Promise<LockAcquisition> {
    const r = getRedis();
    if (!r) {
        const isProd =
            process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
        if (isProd) {
            console.error(
                '[lock] Redis not configured in production — failing CLOSED (refusing lock) to prevent unlocked concurrent execution',
            );
            return { token: null, reason: 'unavailable' };
        }
        console.warn('[lock] Redis not configured — lock disabled (dev mode)');
        // In dev mode return a synthetic token so callers can proceed without Redis.
        return { token: `dev-${crypto.randomUUID()}` };
    }
    try {
        const value = crypto.randomUUID();
        const result = await r.set(key, value, { nx: true, ex: ttlSeconds });
        if (result === 'OK') {
            return { token: value };
        }
        return { token: null, reason: 'contended' };
    } catch (err) {
        console.error('[lock] Redis error during acquireLock:', err);
        // Fail closed — don't execute without lock
        return { token: null, reason: 'unavailable' };
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
