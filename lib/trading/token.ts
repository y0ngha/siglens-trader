import { acquireLock, releaseLock } from '../lock';
import { Redis } from '@upstash/redis';
import type { OAuth2TokenResponse } from './types';

const TOKEN_URL = 'https://openapi.tossinvest.com/oauth2/token';
const REDIS_TOKEN_KEY = 'toss:oauth:token';
const REFRESH_LOCK_KEY = 'toss:oauth:refresh';
const EXPIRY_MARGIN_S = 60;
const LOCK_WAIT_RETRIES = 10;
const LOCK_WAIT_MS = 200;

let redis: Redis | null = null;
function getRedis(): Redis | null {
    if (redis) return redis;
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    redis = new Redis({ url, token });
    return redis;
}

async function issueToken(): Promise<{ token: string; ttl: number }> {
    const clientId = process.env.TOSS_APP_KEY;
    const clientSecret = process.env.TOSS_SECRET_KEY;
    if (!clientId || !clientSecret) {
        throw new Error('TOSS_APP_KEY and TOSS_SECRET_KEY are required');
    }
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
    });
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Toss OAuth2 token issue failed: ${res.status} ${text}`);
    }
    const json = (await res.json()) as OAuth2TokenResponse;
    return { token: json.access_token, ttl: Math.max(1, json.expires_in - EXPIRY_MARGIN_S) };
}

async function cacheToken(token: string, ttl: number): Promise<void> {
    const r = getRedis();
    if (r) await r.set(REDIS_TOKEN_KEY, token, { ex: ttl });
}

export async function forceRefreshToken(): Promise<string> {
    const { token, ttl } = await issueToken();
    await cacheToken(token, ttl);
    return token;
}

export async function getAccessToken(): Promise<string> {
    const r = getRedis();
    if (r) {
        const cached = await r.get<string>(REDIS_TOKEN_KEY);
        if (cached) return cached;
    } else {
        // dev: Redis 없음 → 매번 발급
        const { token } = await issueToken();
        return token;
    }

    // 재발급 직렬화 — 동시 재발급으로 인한 이전 토큰 무효화 race 방지
    const locked = await acquireLock(REFRESH_LOCK_KEY, 10);
    if (locked) {
        try {
            const { token, ttl } = await issueToken();
            await cacheToken(token, ttl);
            return token;
        } finally {
            await releaseLock(REFRESH_LOCK_KEY);
        }
    }

    // 락 실패 — 다른 인스턴스가 발급 중. 캐시를 폴링.
    for (let i = 0; i < LOCK_WAIT_RETRIES; i++) {
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
        const cached = await r.get<string>(REDIS_TOKEN_KEY);
        if (cached) return cached;
    }
    // 그래도 없으면 best-effort 직접 발급
    return forceRefreshToken();
}
