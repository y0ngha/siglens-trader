import { Redis } from '@upstash/redis';

/** Resolves after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let redisClient: Redis | null = null;
/** Lazily constructs the Upstash Redis client from env, or null if unconfigured (dev). */
export function getTradingRedis(): Redis | null {
    if (redisClient) return redisClient;
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    redisClient = new Redis({ url, token });
    return redisClient;
}
