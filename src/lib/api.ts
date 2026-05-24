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

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const FMP_KEY = import.meta.env.VITE_FMP_API_KEY ?? '';
const US_EXCHANGES = new Set(['NYSE', 'NASDAQ', 'AMEX', 'NYSEArca']);

async function searchFmp(query: string, signal?: AbortSignal): Promise<TickerSearchResult[]> {
    if (!FMP_KEY || !query) return [];
    const params = new URLSearchParams({ query, limit: '10', apikey: FMP_KEY });
    const [bySymbol, byName] = await Promise.all([
        fetch(`${FMP_BASE}/search-symbol?${params}`, { signal })
            .then((r) => (r.ok ? r.json() : []))
            .catch(() => []),
        fetch(`${FMP_BASE}/search-name?${params}`, { signal })
            .then((r) => (r.ok ? r.json() : []))
            .catch(() => []),
    ]);
    const seen = new Set<string>();
    const results: TickerSearchResult[] = [];
    for (const item of [...(bySymbol as any[]), ...(byName as any[])]) {
        if (!item?.symbol || !item?.name || !item?.exchange) continue;
        if (!US_EXCHANGES.has(item.exchange)) continue;
        if (seen.has(item.symbol)) continue;
        seen.add(item.symbol);
        results.push({ symbol: item.symbol, name: item.name, exchange: item.exchange });
    }
    return results.slice(0, 10);
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
    closePosition: (id: number) => fetchJson(`/positions/${id}/close`, { method: 'POST' }),
    triggerAnalysis: (symbol: string) =>
        fetchJson('/analysis/trigger', { method: 'POST', body: JSON.stringify({ symbol }) }),
    searchTickers: (query: string, signal?: AbortSignal) => searchFmp(query, signal),
};
