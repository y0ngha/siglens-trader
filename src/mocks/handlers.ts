import { http, HttpResponse, passthrough } from 'msw';

// --- In-memory state ---

let nextId = 100;
function genId() {
    return nextId++;
}

interface ConfigEntry {
    key: string;
    value: string | number;
    updatedAt: string;
}

const configEntries: ConfigEntry[] = [
    { key: 'trading_mode', value: 'dry_run', updatedAt: new Date().toISOString() },
    { key: 'max_position_size', value: 1000, updatedAt: new Date().toISOString() },
    { key: 'max_total_exposure', value: 5000, updatedAt: new Date().toISOString() },
    { key: 'stop_loss_percent', value: 3, updatedAt: new Date().toISOString() },
    { key: 'take_profit_percent', value: 5, updatedAt: new Date().toISOString() },
    { key: 'buy_threshold', value: 70, updatedAt: new Date().toISOString() },
    { key: 'sell_threshold', value: 30, updatedAt: new Date().toISOString() },
    { key: 'analysis_timeframe', value: '1Day', updatedAt: new Date().toISOString() },
];

let watchlist = [
    {
        id: 1,
        symbol: 'AAPL',
        companyName: 'Apple Inc.',
        enabled: true,
        createdAt: new Date().toISOString(),
    },
    {
        id: 2,
        symbol: 'NVDA',
        companyName: 'NVIDIA Corporation',
        enabled: true,
        createdAt: new Date().toISOString(),
    },
    {
        id: 3,
        symbol: 'TSLA',
        companyName: 'Tesla Inc.',
        enabled: true,
        createdAt: new Date().toISOString(),
    },
    {
        id: 4,
        symbol: 'MSFT',
        companyName: 'Microsoft Corporation',
        enabled: false,
        createdAt: new Date().toISOString(),
    },
    {
        id: 5,
        symbol: 'GOOGL',
        companyName: 'Alphabet Inc.',
        enabled: true,
        createdAt: new Date().toISOString(),
    },
];

const analysisConfigs = [
    {
        id: 1,
        analysisType: 'technical',
        enabled: true,
        modelId: 'claude-opus-4-7',
        useByok: true,
        updatedAt: new Date().toISOString(),
    },
    {
        id: 2,
        analysisType: 'news',
        enabled: true,
        modelId: 'gemini-2.5-flash',
        useByok: true,
        updatedAt: new Date().toISOString(),
    },
    {
        id: 3,
        analysisType: 'options',
        enabled: true,
        modelId: 'gemini-2.5-flash',
        useByok: true,
        updatedAt: new Date().toISOString(),
    },
    {
        id: 4,
        analysisType: 'fundamental',
        enabled: true,
        modelId: 'gemini-2.5-flash',
        useByok: true,
        updatedAt: new Date().toISOString(),
    },
];

const notificationConfigs = [
    {
        id: 1,
        channel: 'email',
        enabled: true,
        target: 'dev.y0ngha@gmail.com',
        events: ['trade_executed', 'approval_required', 'error'],
    },
];

const positions = [
    {
        id: 1,
        symbol: 'AAPL',
        side: 'long',
        quantity: 5,
        avgPrice: '189.50',
        currentPrice: '195.20',
        openedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
        status: 'open',
    },
    {
        id: 2,
        symbol: 'NVDA',
        side: 'long',
        quantity: 3,
        avgPrice: '875.20',
        currentPrice: '892.50',
        openedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
        status: 'open',
    },
    {
        id: 3,
        symbol: 'TSLA',
        side: 'long',
        quantity: 8,
        avgPrice: '248.60',
        currentPrice: '252.10',
        openedAt: new Date(Date.now() - 86400000).toISOString(),
        status: 'open',
    },
];

const trades = [
    {
        id: 1,
        symbol: 'AAPL',
        side: 'buy',
        orderType: 'market',
        quantity: 5,
        price: '189.50',
        executedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
        reason: '신호 78/100 — 매수 (기술:85, 뉴스:70, 옵션:75, 펀더멘털:65, 종합:72)',
        mode: 'dry_run',
    },
    {
        id: 2,
        symbol: 'NVDA',
        side: 'buy',
        orderType: 'market',
        quantity: 3,
        price: '875.20',
        executedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
        reason: '신호 82/100 — 매수 (기술:90, 뉴스:80, 옵션:70, 펀더멘털:75, 종합:80)',
        mode: 'dry_run',
    },
    {
        id: 3,
        symbol: 'TSLA',
        side: 'sell',
        orderType: 'market',
        quantity: 5,
        price: '255.30',
        executedAt: new Date(Date.now() - 6 * 3600000).toISOString(),
        reason: '신호 22/100 — 매도 (기술:15, 뉴스:28, 옵션:20, 펀더멘털:30, 종합:18)',
        mode: 'dry_run',
    },
    {
        id: 4,
        symbol: 'GOOGL',
        side: 'buy',
        orderType: 'market',
        quantity: 4,
        price: '176.30',
        executedAt: new Date(Date.now() - 7 * 86400000).toISOString(),
        reason: '신호 73/100 — 매수 (기술:80, 뉴스:68, 옵션:65, 펀더멘털:70, 종합:72)',
        mode: 'dry_run',
    },
    {
        id: 5,
        symbol: 'GOOGL',
        side: 'sell',
        orderType: 'market',
        quantity: 4,
        price: '181.90',
        executedAt: new Date(Date.now() - 4 * 86400000).toISOString(),
        reason: '신호 28/100 — 매도 (기술:20, 뉴스:35, 옵션:30, 펀더멘털:40, 종합:25)',
        mode: 'dry_run',
    },
];

const pendingOrders = [
    {
        id: 1,
        symbol: 'AAPL',
        side: 'buy',
        quantity: 3,
        priceLimit: '195.00',
        analysisSummary: '신호 74/100 — 매수 (기술:82, 뉴스:70, 옵션:68, 펀더멘털:72, 종합:71)',
        signalScore: '74',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 2,
        symbol: 'GOOGL',
        side: 'buy',
        quantity: 5,
        priceLimit: '178.50',
        analysisSummary: '신호 72/100 — 매수 (기술:78, 뉴스:65, 옵션:70, 펀더멘털:68, 종합:70)',
        signalScore: '72',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 12 * 60000).toISOString(),
        status: 'pending',
    },
];

const analysisResults = [
    {
        id: 1,
        symbol: 'AAPL',
        analysisType: 'technical',
        result: JSON.stringify({ trend: 'bullish', riskLevel: 'medium' }),
        createdAt: new Date(Date.now() - 3600000).toISOString(),
    },
    {
        id: 2,
        symbol: 'AAPL',
        analysisType: 'news',
        result: JSON.stringify({ overallSentiment: 'bullish' }),
        createdAt: new Date(Date.now() - 5400000).toISOString(),
    },
    {
        id: 3,
        symbol: 'NVDA',
        analysisType: 'technical',
        result: JSON.stringify({ trend: 'bullish', riskLevel: 'low' }),
        createdAt: new Date(Date.now() - 7200000).toISOString(),
    },
    {
        id: 4,
        symbol: 'NVDA',
        analysisType: 'options',
        result: JSON.stringify({ signals: [{ type: 'bullish' }] }),
        createdAt: new Date(Date.now() - 9000000).toISOString(),
    },
    {
        id: 5,
        symbol: 'TSLA',
        analysisType: 'technical',
        result: JSON.stringify({ trend: 'bearish', riskLevel: 'high' }),
        createdAt: new Date(Date.now() - 1800000).toISOString(),
    },
    {
        id: 6,
        symbol: 'TSLA',
        analysisType: 'news',
        result: JSON.stringify({ overallSentiment: 'bearish' }),
        createdAt: new Date(Date.now() - 3000000).toISOString(),
    },
];

// --- Handlers ---

export const handlers = [
    // Status
    http.get('/api/status', () => {
        const openCount = positions.filter((p) => p.status === 'open').length;
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayCount = trades.filter((t) => new Date(t.executedAt) >= todayStart).length;
        const mode = configEntries.find((c) => c.key === 'trading_mode');
        return HttpResponse.json({
            running: true,
            tradingMode: (mode?.value as string) ?? 'dry_run',
            activePositions: openCount,
            todayTrades: todayCount,
        });
    }),

    // Positions
    http.get('/api/positions', () => {
        return HttpResponse.json(positions.filter((p) => p.status === 'open'));
    }),

    // Close position → add trade record
    http.post('/api/positions/:id/close', ({ params }) => {
        const id = Number(params.id);
        const pos = positions.find((p) => p.id === id);
        if (!pos) return HttpResponse.json({ error: 'Not found' }, { status: 404 });
        pos.status = 'closed';
        trades.push({
            id: genId(),
            symbol: pos.symbol,
            side: 'sell',
            orderType: 'market',
            quantity: pos.quantity,
            price: pos.currentPrice ?? pos.avgPrice,
            executedAt: new Date().toISOString(),
            reason: '수동 청산',
            mode: 'semi_auto',
        });
        return HttpResponse.json({ success: true });
    }),

    // Trades
    http.get('/api/trades', () => {
        return HttpResponse.json([...trades].reverse());
    }),

    // Analysis results
    http.get('/api/analysis', ({ request }) => {
        const url = new URL(request.url);
        const symbol = url.searchParams.get('symbol');
        const filtered = symbol
            ? analysisResults.filter((a) => a.symbol === symbol)
            : analysisResults;
        return HttpResponse.json(filtered);
    }),

    // Trigger analysis
    http.post('/api/analysis/trigger', async ({ request }) => {
        const body = (await request.json()) as { symbol: string };
        analysisResults.push({
            id: genId(),
            symbol: body.symbol,
            analysisType: 'technical',
            result: JSON.stringify({ trend: 'bullish', riskLevel: 'medium' }),
            createdAt: new Date().toISOString(),
        });
        return HttpResponse.json({ success: true });
    }),

    // Pending orders
    http.get('/api/pending', () => {
        return HttpResponse.json(pendingOrders.filter((o) => o.status === 'pending'));
    }),

    // Approve/reject order → approved adds trade record
    http.post('/api/approve/:id', async ({ params, request }) => {
        const id = Number(params.id);
        const body = (await request.json()) as { action: 'approve' | 'reject' };
        const order = pendingOrders.find((o) => o.id === id);
        if (!order) return HttpResponse.json({ error: 'Not found' }, { status: 404 });
        order.status = body.action === 'approve' ? 'approved' : 'rejected';

        if (body.action === 'approve') {
            trades.push({
                id: genId(),
                symbol: order.symbol,
                side: order.side,
                orderType: 'market',
                quantity: order.quantity,
                price: order.priceLimit ?? '0',
                executedAt: new Date().toISOString(),
                reason: order.analysisSummary ?? '승인됨',
                mode: 'semi_auto',
            });
            // If buy, add to positions
            if (order.side === 'buy') {
                positions.push({
                    id: genId(),
                    symbol: order.symbol,
                    side: 'long',
                    quantity: order.quantity,
                    avgPrice: order.priceLimit ?? '0',
                    currentPrice: order.priceLimit ?? '0',
                    openedAt: new Date().toISOString(),
                    status: 'open',
                });
            }
        }

        return HttpResponse.json({ success: true });
    }),

    // Config GET
    http.get('/api/config', () => {
        return HttpResponse.json({
            config: configEntries,
            watchlist,
            analysis: analysisConfigs,
            notification: notificationConfigs,
        });
    }),

    // Config POST — handle all config update types
    http.post('/api/config', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;

        switch (body.type) {
            case 'config': {
                const key = body.key as string;
                const value = body.value;
                const entry = configEntries.find((c) => c.key === key);
                if (entry) {
                    entry.value = value as string | number;
                    entry.updatedAt = new Date().toISOString();
                } else {
                    configEntries.push({
                        key,
                        value: value as string | number,
                        updatedAt: new Date().toISOString(),
                    });
                }
                return HttpResponse.json({ success: true });
            }

            case 'watchlist': {
                const action = body.action as string;
                if (action === 'add') {
                    const symbol = body.symbol as string;
                    const companyName = body.companyName as string;
                    watchlist.push({
                        id: genId(),
                        symbol,
                        companyName,
                        enabled: true,
                        createdAt: new Date().toISOString(),
                    });
                } else if (action === 'remove') {
                    const id = body.id as number;
                    watchlist = watchlist.filter((w) => w.id !== id);
                } else if (action === 'toggle') {
                    const id = body.id as number;
                    const enabled = body.enabled as boolean;
                    const item = watchlist.find((w) => w.id === id);
                    if (item) item.enabled = enabled;
                }
                return HttpResponse.json({ success: true });
            }

            case 'analysis': {
                const analysisType = body.analysisType as string;
                const updates = body.updates as Record<string, unknown>;
                const ac = analysisConfigs.find((a) => a.analysisType === analysisType);
                if (ac) {
                    if (updates.modelId !== undefined) ac.modelId = updates.modelId as string;
                    if (updates.enabled !== undefined) ac.enabled = updates.enabled as boolean;
                    if (updates.useByok !== undefined) ac.useByok = updates.useByok as boolean;
                    ac.updatedAt = new Date().toISOString();
                }
                return HttpResponse.json({ success: true });
            }

            case 'notification': {
                const channel = body.channel as string;
                const updates = body.updates as Record<string, unknown>;
                const nc = notificationConfigs.find((n) => n.channel === channel);
                if (nc) {
                    if (updates.enabled !== undefined) nc.enabled = updates.enabled as boolean;
                    if (updates.target !== undefined) nc.target = updates.target as string;
                    if (updates.events !== undefined) nc.events = updates.events as string[];
                }
                return HttpResponse.json({ success: true });
            }

            default:
                return HttpResponse.json({ error: 'Unknown type' }, { status: 400 });
        }
    }),

    // Search
    // Search — passthrough to Vite dev middleware (which calls real FMP API)
    http.get('/api/search', () => passthrough()),
];
