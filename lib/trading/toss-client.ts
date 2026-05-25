import type { TossOrderRequest, TossOrderResponse, TossBalance } from './types';

const TOSS_BASE_URL = 'https://api.tossinvest.com';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

async function tossRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
): Promise<T> {
    const appKey = process.env.TOSS_APP_KEY;
    const secretKey = process.env.TOSS_SECRET_KEY;
    if (!appKey || !secretKey) {
        throw new Error('TOSS_APP_KEY and TOSS_SECRET_KEY are required');
    }

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secretKey}`,
        'X-App-Key': appKey,
    };
    if (idempotencyKey) {
        headers['X-Idempotency-Key'] = idempotencyKey;
    }

    const url = `${TOSS_BASE_URL}${path}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const res = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (res.ok) {
            return res.json() as Promise<T>;
        }

        // Retry on 5xx server errors
        if (res.status >= 500 && attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
        }

        // Non-retryable error or final attempt
        const text = await res.text();
        throw new Error(`Toss API ${method} ${path} failed: ${res.status} ${text}`);
    }

    // Unreachable, but satisfies TypeScript
    throw new Error(`Toss API ${method} ${path} failed after ${MAX_RETRIES + 1} attempts`);
}

export async function submitOrder(
    req: TossOrderRequest,
    idempotencyKey?: string,
): Promise<TossOrderResponse> {
    const accountNo = process.env.TOSS_ACCOUNT_NO;
    if (!accountNo) {
        throw new Error('TOSS_ACCOUNT_NO is required');
    }

    return tossRequest<TossOrderResponse>(
        'POST',
        '/v1/orders',
        {
            accountNo,
            symbol: req.symbol,
            side: req.side,
            orderType: req.orderType,
            quantity: req.quantity,
            price: req.price,
        },
        idempotencyKey,
    );
}

export async function getBalances(): Promise<TossBalance[]> {
    const accountNo = process.env.TOSS_ACCOUNT_NO;
    if (!accountNo) {
        throw new Error('TOSS_ACCOUNT_NO is required');
    }

    return tossRequest<TossBalance[]>('GET', `/v1/accounts/${accountNo}/balances`);
}
