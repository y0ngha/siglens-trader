import { http, HttpResponse, passthrough } from 'msw';

// --- In-memory state ---

let nextId = 100;
function genId() {
    return nextId++;
}

interface ConfigEntry {
    key: string;
    value: string | number | boolean;
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
    { key: 'analysis_timeframe', value: '1Hour', updatedAt: new Date().toISOString() },
    { key: 'fixed_exit_enabled', value: false, updatedAt: new Date().toISOString() },
    { key: 'trading_enabled', value: true, updatedAt: new Date().toISOString() },
    { key: 'max_trades_per_day', value: 20, updatedAt: new Date().toISOString() },
    { key: 'max_daily_loss_usd', value: 500, updatedAt: new Date().toISOString() },
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

const trades: {
    id: number;
    symbol: string;
    side: string;
    orderType: string;
    quantity: number;
    price: string;
    executedAt: string;
    reason: string;
    mode: string;
    dismissedAt: string | null;
}[] = [
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
        dismissedAt: null,
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
        dismissedAt: null,
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
        dismissedAt: null,
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
        dismissedAt: null,
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
        dismissedAt: null,
    },
    {
        id: 6,
        symbol: 'META',
        side: 'buy',
        orderType: 'market',
        quantity: 0,
        price: '520.00',
        executedAt: new Date(Date.now() - 2 * 3600000).toISOString(),
        reason: '잔고 부족 — 신호 75/100 매수 신호 발생했으나 최대 노출 한도 초과로 미실행',
        mode: 'skipped',
        dismissedAt: null,
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
        symbol: 'NVDA',
        side: 'buy',
        quantity: 2,
        priceLimit: '890.00',
        analysisSummary: '신호 81/100 — 매수 (기술:88, 뉴스:78, 옵션:75, 펀더멘털:80, 종합:79)',
        signalScore: '81',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 3,
        symbol: 'TSLA',
        side: 'sell',
        quantity: 4,
        priceLimit: '258.00',
        analysisSummary: '신호 28/100 — 매도 (기술:22, 뉴스:35, 옵션:25, 펀더멘털:30, 종합:26)',
        signalScore: '28',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 8 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 4,
        symbol: 'MSFT',
        side: 'buy',
        quantity: 3,
        priceLimit: '425.50',
        analysisSummary: '신호 77/100 — 매수 (기술:84, 뉴스:72, 옵션:70, 펀더멘털:78, 종합:75)',
        signalScore: '77',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 11 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 5,
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
    {
        id: 6,
        symbol: 'META',
        side: 'buy',
        quantity: 2,
        priceLimit: '520.00',
        analysisSummary: '신호 75/100 — 매수 (기술:80, 뉴스:73, 옵션:68, 펀더멘털:76, 종합:74)',
        signalScore: '75',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 14 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 7,
        symbol: 'AMD',
        side: 'buy',
        quantity: 6,
        priceLimit: '165.30',
        analysisSummary: '신호 79/100 — 매수 (기술:85, 뉴스:75, 옵션:72, 펀더멘털:80, 종합:77)',
        signalScore: '79',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 9 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 8,
        symbol: 'NFLX',
        side: 'sell',
        quantity: 2,
        priceLimit: '685.00',
        analysisSummary: '신호 32/100 — 매도 (기술:28, 뉴스:38, 옵션:30, 펀더멘털:35, 종합:30)',
        signalScore: '32',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 9,
        symbol: 'AMZN',
        side: 'buy',
        quantity: 3,
        priceLimit: '188.20',
        analysisSummary: '신호 76/100 — 매수 (기술:82, 뉴스:70, 옵션:74, 펀더멘털:75, 종합:74)',
        signalScore: '76',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 13 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 10,
        symbol: 'JPM',
        side: 'buy',
        quantity: 4,
        priceLimit: '205.80',
        analysisSummary: '신호 71/100 — 매수 (기술:76, 뉴스:68, 옵션:66, 펀더멘털:72, 종합:70)',
        signalScore: '71',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 11,
        symbol: 'V',
        side: 'buy',
        quantity: 3,
        priceLimit: '282.40',
        analysisSummary: '신호 73/100 — 매수 (기술:78, 뉴스:70, 옵션:68, 펀더멘털:74, 종합:72)',
        signalScore: '73',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 11 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 12,
        symbol: 'DIS',
        side: 'sell',
        quantity: 7,
        priceLimit: '112.50',
        analysisSummary: '신호 30/100 — 매도 (기술:25, 뉴스:32, 옵션:28, 펀더멘털:35, 종합:28)',
        signalScore: '30',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 6 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 13,
        symbol: 'INTC',
        side: 'buy',
        quantity: 15,
        priceLimit: '32.80',
        analysisSummary: '신호 68/100 — 매수 (기술:72, 뉴스:65, 옵션:62, 펀더멘털:70, 종합:66)',
        signalScore: '68',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 12 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 14,
        symbol: 'CRM',
        side: 'buy',
        quantity: 3,
        priceLimit: '295.60',
        analysisSummary: '신호 78/100 — 매수 (기술:83, 뉴스:74, 옵션:72, 펀더멘털:80, 종합:76)',
        signalScore: '78',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 14 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 15,
        symbol: 'UBER',
        side: 'buy',
        quantity: 8,
        priceLimit: '78.40',
        analysisSummary: '신호 70/100 — 매수 (기술:75, 뉴스:68, 옵션:65, 펀더멘털:70, 종합:68)',
        signalScore: '70',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 9 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 16,
        symbol: 'PLTR',
        side: 'sell',
        quantity: 10,
        priceLimit: '25.90',
        analysisSummary: '신호 26/100 — 매도 (기술:20, 뉴스:30, 옵션:24, 펀더멘털:28, 종합:24)',
        signalScore: '26',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 8 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 17,
        symbol: 'COIN',
        side: 'buy',
        quantity: 4,
        priceLimit: '235.70',
        analysisSummary: '신호 82/100 — 매수 (기술:88, 뉴스:78, 옵션:76, 펀더멘털:82, 종합:80)',
        signalScore: '82',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 18,
        symbol: 'SQ',
        side: 'buy',
        quantity: 5,
        priceLimit: '72.30',
        analysisSummary: '신호 69/100 — 매수 (기술:74, 뉴스:65, 옵션:64, 펀더멘털:70, 종합:67)',
        signalScore: '69',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 19,
        symbol: 'SNAP',
        side: 'sell',
        quantity: 20,
        priceLimit: '14.80',
        analysisSummary: '신호 25/100 — 매도 (기술:18, 뉴스:28, 옵션:22, 펀더멘털:30, 종합:22)',
        signalScore: '25',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 60000).toISOString(),
        status: 'pending',
    },
    {
        id: 20,
        symbol: 'PYPL',
        side: 'buy',
        quantity: 5,
        priceLimit: '68.50',
        analysisSummary: '신호 85/100 — 매수 (기술:90, 뉴스:82, 옵션:80, 펀더멘털:85, 종합:83)',
        signalScore: '85',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 16 * 60000).toISOString(),
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

// --- Cron audit fixtures ---

interface CronRunFixture {
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

interface CronDecisionFixture {
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

const cronRuns: CronRunFixture[] = [
    {
        id: 1,
        runId: 'execute-20260612-1307',
        cronType: 'execute',
        status: 'completed',
        outcome: 'completed',
        startedAt: new Date(Date.now() - 50 * 60000).toISOString(),
        finishedAt: new Date(Date.now() - 49 * 60000).toISOString(),
        durationMs: 4823,
        summary: { symbolsEvaluated: 3, decisionsByAction: { buy: 1, hold: 2, sell: 0 } },
        error: null,
        createdAt: new Date(Date.now() - 50 * 60000).toISOString(),
    },
    {
        id: 2,
        runId: 'technical-20260612-1300',
        cronType: 'technical',
        status: 'completed',
        outcome: 'completed',
        startedAt: new Date(Date.now() - 57 * 60000).toISOString(),
        finishedAt: new Date(Date.now() - 55 * 60000).toISOString(),
        durationMs: 12340,
        summary: { processed: 3, saved: 3 },
        error: null,
        createdAt: new Date(Date.now() - 57 * 60000).toISOString(),
    },
    {
        id: 3,
        runId: 'news-20260612-1300',
        cronType: 'news',
        status: 'completed',
        outcome: 'completed',
        startedAt: new Date(Date.now() - 56 * 60000).toISOString(),
        finishedAt: new Date(Date.now() - 54 * 60000).toISOString(),
        durationMs: 9870,
        summary: { processed: 3, saved: 3 },
        error: null,
        createdAt: new Date(Date.now() - 56 * 60000).toISOString(),
    },
    {
        id: 4,
        runId: 'reconcile-20260612-1310',
        cronType: 'reconcile',
        status: 'completed',
        outcome: 'completed',
        startedAt: new Date(Date.now() - 47 * 60000).toISOString(),
        finishedAt: new Date(Date.now() - 46 * 60000 - 30000).toISOString(),
        durationMs: 1520,
        summary: {
            processed: 2,
            actionsByType: { timeout: 0, consistency_fix: 0 },
            inconsistencies: 0,
        },
        error: null,
        createdAt: new Date(Date.now() - 47 * 60000).toISOString(),
    },
    {
        id: 5,
        runId: 'execute-20260612-1207',
        cronType: 'execute',
        status: 'skipped',
        outcome: 'market_closed',
        startedAt: new Date(Date.now() - 110 * 60000).toISOString(),
        finishedAt: new Date(Date.now() - 109 * 60000 - 50000).toISOString(),
        durationMs: 70,
        summary: null,
        error: null,
        createdAt: new Date(Date.now() - 110 * 60000).toISOString(),
    },
    {
        id: 6,
        runId: 'execute-20260611-2007',
        cronType: 'execute',
        status: 'skipped',
        outcome: 'daily_loss_limit',
        startedAt: new Date(Date.now() - 19 * 3600000).toISOString(),
        finishedAt: new Date(Date.now() - 19 * 3600000 + 90).toISOString(),
        durationMs: 90,
        summary: null,
        error: null,
        createdAt: new Date(Date.now() - 19 * 3600000).toISOString(),
    },
    {
        id: 7,
        runId: 'technical-20260611-1900',
        cronType: 'technical',
        status: 'error',
        outcome: null,
        startedAt: new Date(Date.now() - 20 * 3600000).toISOString(),
        finishedAt: new Date(Date.now() - 20 * 3600000 + 5000).toISOString(),
        durationMs: 5000,
        summary: null,
        error: 'FMP API rate limit exceeded (HTTP 429)',
        createdAt: new Date(Date.now() - 20 * 3600000).toISOString(),
    },
    {
        id: 8,
        runId: 'reconcile-20260611-1920',
        cronType: 'reconcile',
        status: 'completed',
        outcome: 'completed',
        startedAt: new Date(Date.now() - 18 * 3600000).toISOString(),
        finishedAt: new Date(Date.now() - 18 * 3600000 + 2100).toISOString(),
        durationMs: 2100,
        summary: {
            processed: 1,
            actionsByType: { timeout: 1, consistency_fix: 0 },
            inconsistencies: 0,
        },
        error: null,
        createdAt: new Date(Date.now() - 18 * 3600000).toISOString(),
    },
];

const cronDecisions: CronDecisionFixture[] = [
    // Decisions for execute-20260612-1307
    {
        id: 1,
        runId: 'execute-20260612-1307',
        cronType: 'execute',
        symbol: 'AAPL',
        action: 'buy',
        executed: true,
        score: '78.2',
        reason: '신호 78/100 — 매수 (기술:85, 뉴스:70, 옵션:75, 펀더멘털:65, 종합:72)',
        detail: { technical: 85, news: 70, options: 75, fundamental: 65, overall: 72 },
        createdAt: new Date(Date.now() - 49 * 60000 + 2000).toISOString(),
    },
    {
        id: 2,
        runId: 'execute-20260612-1307',
        cronType: 'execute',
        symbol: 'NVDA',
        action: 'hold',
        executed: false,
        score: '55.1',
        reason: '신호 55/100 — 보류 (매수/매도 임계값 사이)',
        detail: { technical: 60, news: 50, options: 55, fundamental: 52, overall: 54 },
        createdAt: new Date(Date.now() - 49 * 60000 + 3000).toISOString(),
    },
    {
        id: 3,
        runId: 'execute-20260612-1307',
        cronType: 'execute',
        symbol: 'TSLA',
        action: 'hold',
        executed: false,
        score: '48.3',
        reason: '신호 48/100 — 보류 (매수/매도 임계값 사이)',
        detail: { technical: 45, news: 52, options: 48, fundamental: 50, overall: 47 },
        createdAt: new Date(Date.now() - 49 * 60000 + 4000).toISOString(),
    },
    // Decisions for reconcile-20260611-1920 (timeout action)
    {
        id: 4,
        runId: 'reconcile-20260611-1920',
        cronType: 'reconcile',
        symbol: 'MSFT',
        action: 'timeout',
        executed: true,
        score: null,
        reason: '주문 30분 초과 — 타임아웃 처리',
        detail: {
            orderId: 'ORD-8821',
            submittedAt: new Date(Date.now() - 19 * 3600000).toISOString(),
        },
        createdAt: new Date(Date.now() - 18 * 3600000 + 1500).toISOString(),
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
        const tradingEnabled = configEntries.find((c) => c.key === 'trading_enabled');
        const maxTradesPerDay = configEntries.find((c) => c.key === 'max_trades_per_day');
        return HttpResponse.json({
            running: true,
            tradingMode: (mode?.value as string) ?? 'dry_run',
            activePositions: openCount,
            todayTrades: todayCount,
            cashBalance: 2000,
            tradingEnabled: (tradingEnabled?.value as boolean) ?? true,
            maxTradesPerDay: (maxTradesPerDay?.value as number) ?? 20,
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
            dismissedAt: null,
        });
        return HttpResponse.json({ success: true });
    }),

    // Trades
    http.get('/api/trades', () => {
        return HttpResponse.json([...trades].reverse());
    }),

    // Dismiss alert
    http.post('/api/trades', async ({ request }) => {
        const body = (await request.json()) as { action: string; id: number };
        if (body.action === 'dismiss') {
            const trade = trades.find((t) => t.id === body.id);
            if (trade) trade.dismissedAt = new Date().toISOString();
            return HttpResponse.json({ success: true });
        }
        return HttpResponse.json({ error: 'Invalid action' }, { status: 400 });
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
        const now = new Date();
        return HttpResponse.json(
            pendingOrders.filter((o) => o.status === 'pending' && new Date(o.expiresAt) > now),
        );
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
                dismissedAt: null,
            });
            // If buy, add to positions — skip if an open position already exists
            if (order.side === 'buy') {
                const existing = positions.find(
                    (p) => p.symbol === order.symbol && p.status === 'open',
                );
                if (!existing) {
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
                    entry.value = value as string | number | boolean;
                    entry.updatedAt = new Date().toISOString();
                } else {
                    configEntries.push({
                        key,
                        value: value as string | number | boolean,
                        updatedAt: new Date().toISOString(),
                    });
                }
                return HttpResponse.json({ success: true });
            }

            case 'watchlist': {
                const action = body.action as string;
                if (action === 'add') {
                    if (watchlist.length >= 5) {
                        return HttpResponse.json(
                            { error: '감시 종목은 최대 5개까지 설정 가능합니다' },
                            { status: 400 },
                        );
                    }
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

    // Cron runs audit log
    http.get('/api/cron-runs', ({ request }) => {
        const url = new URL(request.url);
        const runId = url.searchParams.get('runId');

        if (runId) {
            const decisions = cronDecisions.filter((d) => d.runId === runId);
            return HttpResponse.json({ decisions });
        }

        const typeFilter = url.searchParams.get('type');
        const statusFilter = url.searchParams.get('status');
        const fromFilter = url.searchParams.get('from');
        const toFilter = url.searchParams.get('to');

        let runs = [...cronRuns];

        if (typeFilter) runs = runs.filter((r) => r.cronType === typeFilter);
        if (statusFilter) runs = runs.filter((r) => r.status === statusFilter);
        if (fromFilter) {
            const from = new Date(fromFilter);
            if (!isNaN(from.getTime())) {
                runs = runs.filter((r) => new Date(r.startedAt) >= from);
            }
        }
        if (toFilter) {
            const to = new Date(toFilter);
            if (!isNaN(to.getTime())) {
                runs = runs.filter((r) => new Date(r.startedAt) <= to);
            }
        }

        // Sort by startedAt desc (matches DB query order)
        runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

        return HttpResponse.json({ runs });
    }),

    // Search
    // Search — passthrough to Vite dev middleware (which calls real FMP API)
    http.get('/api/search', () => passthrough()),
];
