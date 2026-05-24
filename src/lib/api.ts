const BASE = '/api';

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options?.headers },
    });
    if (!res.ok) {
        throw new Error(`API ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
}

export interface StatusResponse {
    running: boolean;
    tradingMode: string;
    activePositions: number;
    todayTrades: number;
}

export interface Position {
    id: number;
    symbol: string;
    side: string;
    quantity: number;
    avgPrice: string;
    openedAt: string;
    status: string;
}

export interface Trade {
    id: number;
    symbol: string;
    side: string;
    orderType: string;
    quantity: number;
    price: string;
    executedAt: string;
    reason: string | null;
    mode: string;
}

export interface PendingOrder {
    id: number;
    symbol: string;
    side: string;
    quantity: number;
    priceLimit: string | null;
    analysisSummary: string | null;
    signalScore: string | null;
    createdAt: string;
    expiresAt: string;
    status: string;
}

export const api = {
    getStatus: (signal?: AbortSignal) => fetchJson<StatusResponse>('/status', { signal }),
    getPositions: (signal?: AbortSignal) => fetchJson<Position[]>('/positions', { signal }),
    getTrades: (signal?: AbortSignal) => fetchJson<Trade[]>('/trades', { signal }),
    getAnalysis: (symbol?: string, signal?: AbortSignal) =>
        fetchJson<unknown[]>(symbol ? `/analysis?symbol=${symbol}` : '/analysis', { signal }),
    getConfig: (signal?: AbortSignal) => fetchJson<unknown>('/config', { signal }),
    updateConfig: (body: unknown) =>
        fetchJson('/config', { method: 'POST', body: JSON.stringify(body) }),
    getPending: (signal?: AbortSignal) => fetchJson<PendingOrder[]>('/pending', { signal }),
    approveOrder: (id: number) =>
        fetchJson(`/approve/${id}`, {
            method: 'POST',
            body: JSON.stringify({ action: 'approve' }),
        }),
    rejectOrder: (id: number) =>
        fetchJson(`/approve/${id}`, { method: 'POST', body: JSON.stringify({ action: 'reject' }) }),
};
