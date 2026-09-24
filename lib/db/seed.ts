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
} from './schema.js';

export async function seed() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required');
    }
    const sql = neon(process.env.DATABASE_URL);
    const db = drizzle(sql);

    console.log('Seeding default config...');
    // 일봉 RSI(2) 눌림매수 기본값(docs/specs/2026-09-24-daily-mean-reversion-design.md §6).
    // 예치금 $25k · 종목당 $5k = 동시 5슬롯.
    const defaults = [
        { key: 'trading_mode', value: 'dry_run' },
        { key: 'trading_enabled', value: true },
        { key: 'max_position_size', value: 5000 },
        { key: 'max_total_exposure', value: 25000 },
        { key: 'max_trades_per_day', value: 20 },
        { key: 'max_daily_loss_usd', value: 500 },
        { key: 'dry_run_cash_usd', value: 25000 },
        { key: 'mr_rsi_entry', value: 10 },
        { key: 'mr_max_hold_days', value: 10 },
        { key: 'mr_stop_atr', value: 5 },
        { key: 'mr_regime_filter', value: true },
        { key: 'dry_run_cost_bps', value: 10 },
    ];
    for (const d of defaults) {
        await db
            .insert(config)
            .values({ key: d.key, value: d.value, updatedAt: new Date() })
            .onConflictDoNothing();
    }

    console.log('Seeding analysis model configs...');
    // AI 진입 리뷰(기록 전용)가 쓰는 분석 3종과 리뷰 모델(§5).
    const models = [
        {
            analysisType: 'technical',
            modelId: 'deepseek-v4.1-flash',
            enabled: true,
            useByok: false,
        },
        { analysisType: 'news', modelId: 'deepseek-v4.1-flash', enabled: true, useByok: false },
        {
            analysisType: 'fundamental',
            modelId: 'deepseek-v4.1-flash',
            enabled: true,
            useByok: false,
        },
        {
            analysisType: 'entry_review',
            modelId: 'deepseek-v4.1-flash',
            enabled: true,
            useByok: false,
        },
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
            events: ['trade_executed', 'order_pending', 'stop_loss', 'error', 'cron_health'],
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
            reason: 'Score 78/100 — BUY (tech:85, news:70, opt:75, fund:65)',
            mode: 'dry_run',
        },
        {
            symbol: 'NVDA',
            side: 'buy',
            orderType: 'market',
            quantity: 3,
            price: '875.20',
            executedAt: daysAgo(5),
            reason: 'Score 82/100 — BUY (tech:90, news:80, opt:70, fund:75)',
            mode: 'dry_run',
        },
        {
            symbol: 'TSLA',
            side: 'buy',
            orderType: 'market',
            quantity: 8,
            price: '248.60',
            executedAt: daysAgo(1),
            reason: 'Score 71/100 — BUY (tech:75, news:65, opt:72, fund:60)',
            mode: 'dry_run',
        },
        {
            symbol: 'GOOGL',
            side: 'buy',
            orderType: 'market',
            quantity: 4,
            price: '176.30',
            executedAt: daysAgo(7),
            reason: 'Score 73/100 — BUY (tech:80, news:68, opt:65, fund:70)',
            mode: 'dry_run',
        },
        {
            symbol: 'GOOGL',
            side: 'sell',
            orderType: 'market',
            quantity: 4,
            price: '181.90',
            executedAt: daysAgo(4),
            reason: 'Score 28/100 — SELL (tech:20, news:35, opt:30, fund:40)',
            mode: 'dry_run',
        },
        {
            symbol: 'MSFT',
            side: 'buy',
            orderType: 'market',
            quantity: 3,
            price: '428.50',
            executedAt: daysAgo(6),
            reason: 'Score 76/100 — BUY (tech:82, news:72, opt:68, fund:78)',
            mode: 'dry_run',
        },
        {
            symbol: 'MSFT',
            side: 'sell',
            orderType: 'market',
            quantity: 3,
            price: '435.20',
            executedAt: daysAgo(2),
            reason: 'Score 25/100 — SELL (tech:18, news:30, opt:25, fund:35)',
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
            reason: 'Score 22/100 — SELL (tech:15, news:28, opt:20, fund:30)',
            mode: 'dry_run',
        },
    ];
    for (const t of mockTrades) {
        await db.insert(trades).values(t);
    }

    console.log('Seeding mock analysis results...');
    const analysisTypes = ['technical', 'news', 'fundamental'] as const;
    for (const symbol of ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'GOOGL']) {
        for (const type of analysisTypes) {
            await db.insert(analysisResults).values({
                symbol,
                analysisType: type,
                result: generateMockAnalysisResult(type, symbol),
                modelId: 'deepseek-v4.1-flash',
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
            analysisSummary: 'Score 74/100 — BUY (tech:82, news:70, opt:68, fund:72)',
            signalScore: '74',
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            status: 'pending',
        },
        {
            symbol: 'GOOGL',
            side: 'buy',
            quantity: 5,
            priceLimit: '178.50',
            analysisSummary: 'Score 72/100 — BUY (tech:78, news:65, opt:70, fund:68)',
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
                    entryRecommendation: ['AAPL', 'NVDA'].includes(symbol) ? 'enter' : 'wait',
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
                    { kind: 'bullish', message: 'Call OI 증가' },
                    {
                        kind: symbol === 'TSLA' ? 'bearish' : 'bullish',
                        message: 'Put/Call ratio 변화',
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
        case 'congress':
            return {
                overallSentiment: 'neutral',
                summaryKo: `${symbol} 의회 거래 공시 분석 (목 데이터)`,
                notableMembersKo: [],
                riskNoteKo: '공시 건수가 적어 판단 유보',
            };
        default:
            return {};
    }
}

// Only auto-execute when run directly as a script
if (process.argv[1]?.endsWith('seed.ts')) {
    seed().catch((err) => {
        console.error('Seed failed:', err);
        process.exit(1);
    });
}
