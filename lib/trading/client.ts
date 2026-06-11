import { getAccessToken, forceRefreshToken } from './token';
import { Redis } from '@upstash/redis';

const BASE_URL = 'https://openapi.tossinvest.com';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;
const ACCOUNT_SEQ_KEY = 'toss:account:seq';

export class TossApiError extends Error {
    constructor(
        public code: string,
        message: string,
        public status: number,
        public data?: unknown,
    ) {
        super(message);
        this.name = 'TossApiError';
    }
}

interface TossFetchOptions {
    query?: Record<string, string>;
    body?: unknown;
    account?: boolean;
}

let redis: Redis | null = null;
function getRedis(): Redis | null {
    if (redis) return redis;
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    redis = new Redis({ url, token });
    return redis;
}

let memoSeq: number | null = null;
export async function resolveAccountSeq(): Promise<number> {
    if (memoSeq != null) return memoSeq;
    const r = getRedis();
    if (r) {
        const cached = await r.get<number>(ACCOUNT_SEQ_KEY);
        if (cached != null) {
            memoSeq = Number(cached);
            return memoSeq;
        }
    }
    const accounts = await tossFetch<Array<{ accountSeq: number; accountType: string }>>(
        'GET',
        '/api/v1/accounts',
    );
    const brokerage = accounts.find((a) => a.accountType === 'BROKERAGE') ?? accounts[0];
    if (!brokerage) throw new Error('No Toss account found');
    memoSeq = brokerage.accountSeq;
    if (r) await r.set(ACCOUNT_SEQ_KEY, memoSeq, { ex: 86400 });
    return memoSeq;
}

function parseError(status: number, text: string): TossApiError {
    try {
        const json = JSON.parse(text);
        const e = json.error ?? json; // OAuth2 error는 {error, error_description}
        const code = e.code ?? e.error ?? `http-${status}`;
        const message = e.message ?? e.error_description ?? text;
        return new TossApiError(code, message, status, e.data);
    } catch {
        return new TossApiError(`http-${status}`, text, status);
    }
}

const RETRYABLE_CONFLICT = new Set(['request-in-progress']);

export async function tossFetch<T>(
    method: string,
    path: string,
    opts: TossFetchOptions = {},
): Promise<T> {
    const hasClientOrderId =
        method === 'POST' &&
        typeof opts.body === 'object' &&
        opts.body !== null &&
        'clientOrderId' in (opts.body as Record<string, unknown>);

    let url = `${BASE_URL}${path}`;
    if (opts.query) url += `?${new URLSearchParams(opts.query).toString()}`;

    let triedRefresh = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const token = await getAccessToken();
        const headers: Record<string, string> = {
            Authorization: `Bearer ${token}`,
        };
        if (opts.body != null) headers['Content-Type'] = 'application/json';
        if (opts.account) headers['X-Tossinvest-Account'] = String(await resolveAccountSeq());

        const httpRes = await fetch(url, {
            method,
            headers,
            body: opts.body != null ? JSON.stringify(opts.body) : undefined,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (httpRes.ok) {
            const json = (await httpRes.json()) as { result?: T };
            return (json.result ?? (json as unknown)) as T;
        }

        const text = await httpRes.text();
        const err = parseError(httpRes.status, text);

        // 401 → 실패한 토큰을 넘겨 강제 재발급 후 1회 재시도
        if (httpRes.status === 401 && !triedRefresh) {
            triedRefresh = true;
            await forceRefreshToken(token);
            continue;
        }

        // 409: request-in-progress만 재시도, idempotency-key-conflict 등은 throw
        if (httpRes.status === 409) {
            if (RETRYABLE_CONFLICT.has(err.code) && attempt < MAX_RETRIES) {
                await delay(BASE_DELAY_MS);
                continue;
            }
            throw err;
        }

        // 429: Retry-After 존중
        if (httpRes.status === 429 && attempt < MAX_RETRIES) {
            const ra = Number(httpRes.headers.get('Retry-After') ?? '1');
            await delay(Number.isFinite(ra) ? ra * 1000 : BASE_DELAY_MS);
            continue;
        }

        // 5xx 재시도: GET은 항상, POST는 clientOrderId 있을 때만(멱등)
        const retriable5xx = httpRes.status >= 500 && (method === 'GET' || hasClientOrderId);
        if (retriable5xx && attempt < MAX_RETRIES) {
            await delay(BASE_DELAY_MS * Math.pow(2, attempt));
            continue;
        }

        throw err;
    }

    /* c8 ignore next 2 — defensive fallback: all retry paths throw before loop exits */
    throw new TossApiError('exhausted', `Toss API ${method} ${path} failed`, 0);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
