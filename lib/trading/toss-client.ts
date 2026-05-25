import type { TossOrderRequest, TossOrderResponse, TossBalance } from './types';

const TOSS_BASE_URL = 'https://api.tossinvest.com';
const FETCH_TIMEOUT_MS = 10_000;

async function tossRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const appKey = process.env.TOSS_APP_KEY;
    const secretKey = process.env.TOSS_SECRET_KEY;
    if (!appKey || !secretKey) {
        throw new Error('TOSS_APP_KEY and TOSS_SECRET_KEY are required');
    }

    const res = await fetch(`${TOSS_BASE_URL}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${secretKey}`,
            'X-App-Key': appKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Toss API ${method} ${path} failed: ${res.status} ${text}`);
    }

    return res.json() as Promise<T>;
}

export async function submitOrder(req: TossOrderRequest): Promise<TossOrderResponse> {
    const accountNo = process.env.TOSS_ACCOUNT_NO;
    if (!accountNo) {
        throw new Error('TOSS_ACCOUNT_NO is required');
    }

    return tossRequest<TossOrderResponse>('POST', '/v1/orders', {
        accountNo,
        symbol: req.symbol,
        side: req.side,
        orderType: req.orderType,
        quantity: req.quantity,
        price: req.price,
    });
}

export async function getBalances(): Promise<TossBalance[]> {
    const accountNo = process.env.TOSS_ACCOUNT_NO;
    if (!accountNo) {
        throw new Error('TOSS_ACCOUNT_NO is required');
    }

    return tossRequest<TossBalance[]>('GET', `/v1/accounts/${accountNo}/balances`);
}
