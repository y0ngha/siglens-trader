import type { Connect } from 'vite';

const mockStatus = {
    running: true,
    tradingMode: 'dry_run',
    activePositions: 3,
    todayTrades: 5,
};

const mockPositions = [
    {
        id: 1,
        symbol: 'AAPL',
        side: 'long',
        quantity: 5,
        avgPrice: '189.50',
        openedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
        status: 'open',
    },
    {
        id: 2,
        symbol: 'NVDA',
        side: 'long',
        quantity: 3,
        avgPrice: '875.20',
        openedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
        status: 'open',
    },
    {
        id: 3,
        symbol: 'TSLA',
        side: 'long',
        quantity: 8,
        avgPrice: '248.60',
        openedAt: new Date(Date.now() - 86400000).toISOString(),
        status: 'open',
    },
];

const mockTrades = [
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

const mockPending = [
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

const mockConfig = {
    tradingMode: 'dry_run',
    watchlist: [
        { symbol: 'AAPL', name: 'Apple Inc.', enabled: true },
        { symbol: 'NVDA', name: 'NVIDIA Corporation', enabled: true },
        { symbol: 'TSLA', name: 'Tesla Inc.', enabled: true },
        { symbol: 'MSFT', name: 'Microsoft Corporation', enabled: true },
        { symbol: 'GOOGL', name: 'Alphabet Inc.', enabled: true },
    ],
    analysis: [
        { type: 'technical', enabled: true, model: 'claude-opus-4-7', byok: true },
        { type: 'news', enabled: true, model: 'gemini-2.5-flash', byok: true },
        { type: 'options', enabled: true, model: 'gemini-2.5-flash', byok: true },
        { type: 'fundamental', enabled: true, model: 'gemini-2.5-flash', byok: true },
    ],
    risk: {
        maxPositionSize: 1000,
        maxTotalExposure: 5000,
        stopLossPercent: 3,
        takeProfitPercent: 5,
        buyThreshold: 70,
        sellThreshold: 30,
    },
    notifications: {
        emailEnabled: true,
        events: ['trade_executed', 'approval_required', 'error'],
    },
};

const mockAnalysis = [
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

const routes: Record<string, (req: Connect.IncomingMessage) => unknown> = {
    '/api/status': () => mockStatus,
    '/api/positions': () => mockPositions,
    '/api/trades': () => mockTrades,
    '/api/pending': () => mockPending,
    '/api/config': () => mockConfig,
    '/api/analysis': () => mockAnalysis,
};

export function apiMockMiddleware(): Connect.NextHandleFunction {
    return (req, res, next) => {
        const url = req.url ?? '';

        if (!url.startsWith('/api/')) return next();

        // Handle approve
        if (url.startsWith('/api/approve/')) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        const handler = routes[url.split('?')[0]];
        if (!handler) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(handler(req)));
    };
}
