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
    cashBalance?: number;
    tradingEnabled?: boolean;
    maxTradesPerDay?: number;
}

export interface Position {
    id: number;
    symbol: string;
    side: string;
    quantity: number;
    avgPrice: string;
    currentPrice?: string;
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
    dismissedAt: string | null;
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

export interface TickerSearchResult {
    symbol: string;
    name: string;
    exchange: string;
}

export interface CronRun {
    id: number;
    runId: string;
    cronType: string;
    status: string;
    outcome: string | null;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    summary: unknown;
    error: string | null;
    createdAt: string;
}

export interface CronDecision {
    id: number;
    runId: string;
    cronType: string;
    symbol: string | null;
    action: string;
    executed: boolean;
    score: string | null;
    reason: string | null;
    detail: unknown;
    createdAt: string;
}

export const api = {
    getStatus: (signal?: AbortSignal) => fetchJson<StatusResponse>('/status', { signal }),
    getPositions: (signal?: AbortSignal) => fetchJson<Position[]>('/positions', { signal }),
    getTrades: (signal?: AbortSignal) => fetchJson<Trade[]>('/trades', { signal }),
    getAnalysis: (symbol?: string, signal?: AbortSignal) =>
        fetchJson<unknown[]>(
            symbol ? `/analysis?symbol=${encodeURIComponent(symbol)}` : '/analysis',
            { signal },
        ),
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
    closePosition: (id: number, price?: number) =>
        fetchJson(`/positions/${id}/close`, {
            method: 'POST',
            body: JSON.stringify(price ? { price } : {}),
        }),
    triggerAnalysis: (symbol: string) =>
        fetchJson('/analysis/trigger', { method: 'POST', body: JSON.stringify({ symbol }) }),
    dismissAlert: (id: number) =>
        fetchJson<{ success: boolean }>('/trades', {
            method: 'POST',
            body: JSON.stringify({ action: 'dismiss', id }),
        }),
    searchTickers: (query: string, signal?: AbortSignal) =>
        fetchJson<TickerSearchResult[]>(`/search?q=${encodeURIComponent(query)}`, { signal }),
    getCronRuns: (
        filters: { type?: string; status?: string; from?: string; to?: string } = {},
        signal?: AbortSignal,
    ) => {
        const qs = new URLSearchParams();
        if (filters.type) qs.set('type', encodeURIComponent(filters.type));
        if (filters.status) qs.set('status', encodeURIComponent(filters.status));
        if (filters.from) qs.set('from', encodeURIComponent(filters.from));
        if (filters.to) qs.set('to', encodeURIComponent(filters.to));
        const query = qs.toString();
        return fetchJson<{ runs: CronRun[] }>(`/cron-runs${query ? `?${query}` : ''}`, { signal });
    },
    getCronDecisions: (runId: string, signal?: AbortSignal) =>
        fetchJson<{ decisions: CronDecision[] }>(`/cron-runs?runId=${encodeURIComponent(runId)}`, {
            signal,
        }),
};
