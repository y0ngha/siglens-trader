import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import {
    config,
    analysisModelConfig,
    notificationConfig,
    watchlist,
    positions,
    trades,
    analysisResults,
    pendingOrders,
} from './schema';

async function seed() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required');
    }
    const sql = neon(process.env.DATABASE_URL);
    const db = drizzle(sql);

    console.log('Seeding default config...');
    const defaults = [
        { key: 'trading_mode', value: 'dry_run' },
        { key: 'max_position_size', value: 1000 },
        { key: 'max_total_exposure', value: 5000 },
        { key: 'stop_loss_percent', value: 3 },
        { key: 'take_profit_percent', value: 5 },
        { key: 'buy_threshold', value: 70 },
        { key: 'sell_threshold', value: 30 },
    ];
    for (const d of defaults) {
        await db
            .insert(config)
            .values({ key: d.key, value: d.value, updatedAt: new Date() })
            .onConflictDoNothing();
    }

    console.log('Seeding analysis model configs...');
    const models = [
        { analysisType: 'technical', modelId: 'claude-opus-4-7', enabled: true, useByok: true },
        { analysisType: 'news', modelId: 'gemini-2.5-flash', enabled: true, useByok: true },
        { analysisType: 'options', modelId: 'gemini-2.5-flash', enabled: true, useByok: true },
        { analysisType: 'fundamental', modelId: 'gemini-2.5-flash', enabled: true, useByok: true },
        { analysisType: 'overall', modelId: 'claude-opus-4-7', enabled: true, useByok: true },
    ];
    for (const m of models) {
        await db
            .insert(analysisModelConfig)
            .values({ ...m, updatedAt: new Date() })
            .onConflictDoNothing();
    }

    console.log('Seeding notification config...');
    await db
        .insert(notificationConfig)
        .values({
            channel: 'email',
            enabled: true,
            target: 'dev.y0ngha@gmail.com',
            events: ['trade_executed', 'approval_required', 'error'],
        })
        .onConflictDoNothing();

    console.log('Seeding watchlist...');
    const watchlistItems = [
        { symbol: 'AAPL', companyName: 'Apple Inc.' },
        { symbol: 'NVDA', companyName: 'NVIDIA Corporation' },
        { symbol: 'TSLA', companyName: 'Tesla Inc.' },
        { symbol: 'MSFT', companyName: 'Microsoft Corporation' },
        { symbol: 'GOOGL', companyName: 'Alphabet Inc.' },
    ];
    for (const w of watchlistItems) {
        await db.insert(watchlist).values(w).onConflictDoNothing();
    }

    console.log('Seeding mock positions...');
    await db
        .insert(positions)
        .values([
            {
                symbol: 'AAPL',
                side: 'long',
                quantity: 5,
                avgPrice: '189.50',
                openedAt: daysAgo(3),
                status: 'open',
            },
            {
                symbol: 'NVDA',
                side: 'long',
                quantity: 3,
                avgPrice: '875.20',
                openedAt: daysAgo(5),
                status: 'open',
            },
            {
                symbol: 'TSLA',
                side: 'long',
                quantity: 8,
                avgPrice: '248.60',
                openedAt: daysAgo(1),
                status: 'open',
            },
        ])
        .onConflictDoNothing();

    console.log('Seeding mock trades...');
    const mockTrades = [
        {
            symbol: 'AAPL',
            side: 'buy',
            orderType: 'market',
            quantity: 5,
            price: '189.50',
            executedAt: daysAgo(3),
            reason: 'Score 78/100 — BUY (tech:85, news:70, opt:75, fund:65, overall:72)',
            mode: 'dry_run',
        },
        {
            symbol: 'NVDA',
            side: 'buy',
            orderType: 'market',
            quantity: 3,
            price: '875.20',
            executedAt: daysAgo(5),
            reason: 'Score 82/100 — BUY (tech:90, news:80, opt:70, fund:75, overall:80)',
            mode: 'dry_run',
        },
        {
            symbol: 'TSLA',
            side: 'buy',
            orderType: 'market',
            quantity: 8,
            price: '248.60',
            executedAt: daysAgo(1),
            reason: 'Score 71/100 — BUY (tech:75, news:65, opt:72, fund:60, overall:68)',
            mode: 'dry_run',
        },
        {
            symbol: 'GOOGL',
            side: 'buy',
            orderType: 'market',
            quantity: 4,
            price: '176.30',
            executedAt: daysAgo(7),
            reason: 'Score 73/100 — BUY (tech:80, news:68, opt:65, fund:70, overall:72)',
            mode: 'dry_run',
        },
        {
            symbol: 'GOOGL',
            side: 'sell',
            orderType: 'market',
            quantity: 4,
            price: '181.90',
            executedAt: daysAgo(4),
            reason: 'Score 28/100 — SELL (tech:20, news:35, opt:30, fund:40, overall:25)',
            mode: 'dry_run',
        },
        {
            symbol: 'MSFT',
            side: 'buy',
            orderType: 'market',
            quantity: 3,
            price: '428.50',
            executedAt: daysAgo(6),
            reason: 'Score 76/100 — BUY (tech:82, news:72, opt:68, fund:78, overall:75)',
            mode: 'dry_run',
        },
        {
            symbol: 'MSFT',
            side: 'sell',
            orderType: 'market',
            quantity: 3,
            price: '435.20',
            executedAt: daysAgo(2),
            reason: 'Score 25/100 — SELL (tech:18, news:30, opt:25, fund:35, overall:22)',
            mode: 'dry_run',
        },
        {
            symbol: 'AAPL',
            side: 'sell',
            orderType: 'market',
            quantity: 3,
            price: '192.80',
            executedAt: daysAgo(6),
            reason: 'Score 29/100 — SELL (이전 포지션 정리)',
            mode: 'dry_run',
        },
        {
            symbol: 'NVDA',
            side: 'sell',
            orderType: 'market',
            quantity: 2,
            price: '890.40',
            executedAt: daysAgo(4),
            reason: 'Score 26/100 — SELL (부분 익절)',
            mode: 'dry_run',
        },
        {
            symbol: 'TSLA',
            side: 'sell',
            orderType: 'market',
            quantity: 5,
            price: '255.30',
            executedAt: hoursAgo(6),
            reason: 'Score 22/100 — SELL (tech:15, news:28, opt:20, fund:30, overall:18)',
            mode: 'dry_run',
        },
    ];
    for (const t of mockTrades) {
        await db.insert(trades).values(t);
    }

    console.log('Seeding mock analysis results...');
    const analysisTypes = ['technical', 'news', 'options', 'fundamental'] as const;
    for (const symbol of ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'GOOGL']) {
        for (const type of analysisTypes) {
            await db.insert(analysisResults).values({
                symbol,
                analysisType: type,
                result: generateMockAnalysisResult(type, symbol),
                modelId: type === 'technical' ? 'claude-opus-4-7' : 'gemini-2.5-flash',
                analyzedAt: hoursAgo(1),
                cronRunId: `${type}-mock`,
            });
        }
    }

    console.log('Seeding mock pending orders...');
    await db.insert(pendingOrders).values([
        {
            symbol: 'AAPL',
            side: 'buy',
            quantity: 3,
            priceLimit: '195.00',
            analysisSummary: 'Score 74/100 — BUY (tech:82, news:70, opt:68, fund:72, overall:71)',
            signalScore: '74',
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            status: 'pending',
        },
        {
            symbol: 'GOOGL',
            side: 'buy',
            quantity: 5,
            priceLimit: '178.50',
            analysisSummary: 'Score 72/100 — BUY (tech:78, news:65, opt:70, fund:68, overall:70)',
            signalScore: '72',
            expiresAt: new Date(Date.now() + 12 * 60 * 1000),
            status: 'pending',
        },
    ]);

    console.log('Seed complete!');
}

function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function hoursAgo(hours: number): Date {
    return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function generateMockAnalysisResult(type: string, symbol: string): object {
    switch (type) {
        case 'technical':
            return {
                trend: ['AAPL', 'NVDA', 'MSFT'].includes(symbol) ? 'bullish' : 'neutral',
                riskLevel: symbol === 'TSLA' ? 'high' : 'medium',
                keyLevels: {
                    support: [180, 175, 170],
                    resistance: [200, 205, 210],
                    currentPrice:
                        symbol === 'AAPL'
                            ? 195.2
                            : symbol === 'NVDA'
                              ? 892.5
                              : symbol === 'TSLA'
                                ? 252.1
                                : symbol === 'MSFT'
                                  ? 433.8
                                  : 179.4,
                },
                actionRecommendation: {
                    action: ['AAPL', 'NVDA'].includes(symbol) ? 'buy' : 'hold',
                    confidence: 0.72,
                },
            };
        case 'news':
            return {
                overallSentiment: ['AAPL', 'NVDA'].includes(symbol) ? 'bullish' : 'neutral',
                keyEventsKo: ['실적 발표 예정', '신제품 출시 루머'],
                currentDriverKo: '기술주 전반 강세',
            };
        case 'options':
            return {
                signals: [
                    { type: 'bullish', description: 'Call OI 증가' },
                    {
                        type: symbol === 'TSLA' ? 'bearish' : 'bullish',
                        description: 'Put/Call ratio 변화',
                    },
                ],
                summary: `${symbol} 옵션 시장 분석 완료`,
            };
        case 'fundamental':
            return {
                overallSentiment: symbol === 'TSLA' ? 'neutral' : 'bullish',
                categoryAssessments: [
                    { category: 'valuation', rating: 'fair' },
                    { category: 'growth', rating: 'strong' },
                ],
            };
        default:
            return {};
    }
}

seed().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
});
