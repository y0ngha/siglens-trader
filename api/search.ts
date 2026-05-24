import { readFmpConfig } from '@y0ngha/siglens-core';
import { isAuthenticated } from './_lib/auth';

const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';
const FMP_SEARCH_LIMIT = 10;
const US_EXCHANGES = new Set(['NYSE', 'NASDAQ', 'AMEX', 'NYSEArca']);

export default async function handler(req: Request): Promise<Response> {
    if (!isAuthenticated(req)) return new Response('Forbidden', { status: 403 });
    if (req.method !== 'GET') return new Response(null, { status: 405 });

    const url = new URL(req.url);
    const query = url.searchParams.get('q');
    if (!query || query.length < 1) {
        return Response.json([]);
    }

    try {
        const { apiKey } = readFmpConfig();
        const params = new URLSearchParams({
            query,
            limit: String(FMP_SEARCH_LIMIT),
            apikey: apiKey,
        });

        const [bySymbol, byName] = await Promise.all([
            fetchFmp(`search-symbol?${params}`),
            fetchFmp(`search-name?${params}`),
        ]);

        const seen = new Set<string>();
        const results: Array<{ symbol: string; name: string; exchange: string }> = [];

        for (const item of [...bySymbol, ...byName]) {
            if (!item.symbol || !item.name || !item.exchange) continue;
            if (!US_EXCHANGES.has(item.exchange)) continue;
            if (seen.has(item.symbol)) continue;
            seen.add(item.symbol);
            results.push({ symbol: item.symbol, name: item.name, exchange: item.exchange });
        }

        return Response.json(results.slice(0, 10));
    } catch {
        return Response.json([]);
    }
}

async function fetchFmp(path: string): Promise<Array<Record<string, string>>> {
    try {
        const res = await fetch(`${FMP_BASE_URL}/${path}`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}
