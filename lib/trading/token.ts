import { acquireLock, releaseLock } from '../lock';
import { Redis } from '@upstash/redis';
import type { OAuth2TokenResponse } from './types';
import { delay, getTradingRedis } from './_util';

const TOKEN_URL = 'https://openapi.tossinvest.com/oauth2/token';
const REDIS_TOKEN_KEY = 'toss:oauth:token';
const REFRESH_LOCK_KEY = 'toss:oauth:refresh';
const EXPIRY_MARGIN_S = 60;
const ISSUE_TIMEOUT_MS = 10_000;
const LOCK_TTL_S = 15; // > ISSUE_TIMEOUT_MS(10s) + 캐시 쓰기 여유
const POLL_INTERVAL_MS = 250;
const MAX_WAIT_MS = 25_000; // > LOCK_TTL_S: 락 보유자가 죽어도 TTL 만료 후 재획득 가능

let _redisWarnedOnce = false;
function getRedis(): Redis | null {
    const r = getTradingRedis();
    if (!r) {
        if (!_redisWarnedOnce) {
            _redisWarnedOnce = true;
            console.warn(
                '[toss-token] Redis not configured — token cache + refresh lock disabled; not safe for production (token re-issue storms).',
            );
        }
        return null;
    }
    return r;
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
        signal: AbortSignal.timeout(ISSUE_TIMEOUT_MS),
    });
    if (!res.ok) {
        const text = await res.text();
        let detail = `status ${res.status}`;
        try {
            const j = JSON.parse(text) as { error?: string; error_description?: string };
            if (j.error) detail = `${res.status} ${j.error}`; // OAuth2 표준 error code만 노출 (본문 원문 비노출)
        } catch {
            /* non-JSON body — keep status only */
        }
        throw new Error(`Toss OAuth2 token issue failed: ${detail}`);
    }
    const json = (await res.json()) as OAuth2TokenResponse;
    const expiresIn =
        typeof json.expires_in === 'number' && Number.isFinite(json.expires_in)
            ? json.expires_in
            : 86400; // 누락/비정상 시 24h 기본값
    return { token: json.access_token, ttl: Math.max(1, expiresIn - EXPIRY_MARGIN_S) };
}

async function cacheToken(token: string, ttl: number): Promise<void> {
    const r = getRedis();
    if (r) await r.set(REDIS_TOKEN_KEY, token, { ex: ttl });
}

// dev(Redis 미설정): 프로세스 로컬 캐시로 재발급 storm 방지 (토스는 재발급 시 이전 토큰 무효화)
let devToken: { token: string; expiresAt: number } | null = null;
async function issueDevToken(): Promise<string> {
    if (devToken && devToken.expiresAt > Date.now()) return devToken.token;
    const { token, ttl } = await issueToken();
    devToken = { token, expiresAt: Date.now() + ttl * 1000 };
    return token;
}

// 항상 락 안에서만 발급한다(언락 발급 금지 — one-token-per-client 불변식).
// allowReuse=true 이면, 다른 인스턴스가 이미 캐시한 (staleToken 과 다른) 토큰을 재사용한다.
async function issueUnderLock(
    r: Redis,
    staleToken: string | undefined,
    allowReuse: boolean,
): Promise<string> {
    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
        const locked = await acquireLock(REFRESH_LOCK_KEY, LOCK_TTL_S);
        if (locked) {
            try {
                if (allowReuse) {
                    const fresh = await r.get<string>(REDIS_TOKEN_KEY);
                    if (fresh && fresh !== staleToken) return fresh; // 락 대기 중 다른 인스턴스가 발급함
                }
                const { token, ttl } = await issueToken();
                await cacheToken(token, ttl);
                return token;
            } finally {
                await releaseLock(REFRESH_LOCK_KEY);
            }
        }
        // 다른 인스턴스가 발급 중 — 캐시에 토큰이 올라오면 재사용
        if (allowReuse) {
            const cached = await r.get<string>(REDIS_TOKEN_KEY);
            if (cached && cached !== staleToken) return cached;
        }
        if (Date.now() >= deadline) {
            throw new Error('Toss token refresh timed out waiting for lock');
        }
        await delay(POLL_INTERVAL_MS);
    }
}

export async function getAccessToken(): Promise<string> {
    const r = getRedis();
    if (!r) return issueDevToken();
    const cached = await r.get<string>(REDIS_TOKEN_KEY);
    if (cached) return cached;
    return issueUnderLock(r, undefined, true);
}

// staleToken: 401 을 유발한(무효화된) 토큰. 전달 시 그 토큰과 다른 캐시 값은 재사용(stampede 방지),
// 같으면 새로 발급. 미전달 시 무조건 재발급(allowReuse=false).
export async function forceRefreshToken(staleToken?: string): Promise<string> {
    const r = getRedis();
    if (!r) {
        devToken = null;
        return issueDevToken();
    }
    return issueUnderLock(r, staleToken, staleToken !== undefined);
}
