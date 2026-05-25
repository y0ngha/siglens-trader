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

export async function acquireLock(
    key: string,
    ttlSeconds = DEFAULT_LOCK_TTL_SECONDS,
): Promise<boolean> {
    const r = getRedis();
    if (!r) {
        console.warn('[lock] Redis not configured — lock disabled (dev mode)');
        return true;
    }
    const result = await r.set(key, Date.now().toString(), { nx: true, ex: ttlSeconds });
    return result === 'OK';
}

export async function releaseLock(key: string): Promise<void> {
    const r = getRedis();
    if (!r) return;
    await r.del(key);
}
