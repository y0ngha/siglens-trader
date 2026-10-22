import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wilderAtr, type DailyBar } from '../../../lib/strategy/mean-reversion';

// ---------------------------------------------------------------------------
// Mocks — 규칙(`mean-reversion`)·손실 계산(`daily-loss`)·예산(`trade-plan`)은 실제 모듈이다.
// 이 테스트가 확인하는 것이 바로 그 배선이다.
// ---------------------------------------------------------------------------

vi.mock('../../_lib/cron-auth', () => ({ verifyCronSecret: () => true }));

const tx = { tx: true };
const fakeDb = { fake: 'db', transaction: async <T>(fn: (t: unknown) => Promise<T>) => fn(tx) };
vi.mock('../../_lib/db', () => ({ getDb: () => fakeDb }));

const mockCash = vi.fn();
vi.mock('../../_lib/cash', () => ({ getAvailableCashUsd: (...a: unknown[]) => mockCash(...a) }));

const q = vi.hoisted(() => ({
    getEnabledWatchlist: vi.fn(),
    getConfigValue: vi.fn(),
    getOpenPositions: vi.fn(),
    getPendingOrders: vi.fn(),
    getTodayTradeCount: vi.fn(),
    getTodayInflightOrderCount: vi.fn(),
    getTodayRealizedPnl: vi.fn(),
    getNeedsReviewSymbols: vi.fn(),
    expireOldPendingOrders: vi.fn(),
    getPendingSubmittedOrders: vi.fn(),
    getNotificationConfig: vi.fn(),
    enqueueNotification: vi.fn(),
    startCronRun: vi.fn(),
    finishCronRun: vi.fn(),
    finalizeStaleCronRuns: vi.fn(),
    insertCronDecisions: vi.fn(),
    hasDecisionPhaseSince: vi.fn(),
    setPositionStopPrice: vi.fn(),
    getNoPriceStreak: vi.fn(),
    getSymbolsSoldSince: vi.fn(),
    getLatestSizing: vi.fn(),
    getFirstSoftRegimeActiveSince: vi.fn(),
}));
vi.mock('../../../lib/db/queries', () =>
    Object.fromEntries(
        Object.entries(q).map(([k, fn]) => [
            k,
            (...a: unknown[]) => (fn as (...x: unknown[]) => unknown)(...a),
        ]),
    ),
);

const mockExecuteEntry = vi.fn();
const mockExecuteExit = vi.fn();
vi.mock('../_orders', () => ({
    executeEntry: (...a: unknown[]) => mockExecuteEntry(...a),
    executeExit: (...a: unknown[]) => mockExecuteExit(...a),
}));

const mockFetchDailyBars =
    vi.fn<(symbol: string, live: number | null, now: Date) => Promise<DailyBar[] | null>>();
vi.mock('../../../lib/analysis/daily-bars', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../lib/analysis/daily-bars')>()),
    fetchDailyBars: (...a: [string, number | null, Date]) => mockFetchDailyBars(...a),
}));

vi.mock('../../../lib/sleep', () => ({ sleep: async () => {} }));

const mockQuote = vi.fn();
vi.mock('../../../lib/data/live-price', () => ({
    fetchLivePriceDetail: (...a: unknown[]) => mockQuote(...a),
}));

const mockClaimOnce = vi.fn();
const mockLock = vi.fn();
vi.mock('../../../lib/lock', () => ({
    acquireLockDetailed: (...a: unknown[]) => mockLock(...a),
    releaseLock: async () => {},
    claimOnce: (...a: unknown[]) => mockClaimOnce(...a),
}));

const mockIsUsMarketOpen = vi.fn();
vi.mock('../../../lib/trading/account', () => ({
    isUsMarketOpen: (...a: unknown[]) => mockIsUsMarketOpen(...a),
}));

const mockSendError = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../lib/notification/email', () => ({
    sendTradeExecutedEmail: vi.fn(),
    sendApprovalRequestEmail: vi.fn(),
    sendErrorEmail: (...a: unknown[]) => mockSendError(...a),
}));
// 메일 경로와 digest가 같은 시각을 읽는지(불변식) 보려고 dispatcher 생성 인자만 엿본다.
const dispatcherDeps = vi.hoisted(() => [] as Array<{ digestHour?: number }>);
vi.mock('../../../lib/notification/dispatch', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../lib/notification/dispatch')>();
    return {
        ...actual,
        createEmailDispatcher: (deps: Parameters<typeof actual.createEmailDispatcher>[0]) => {
            dispatcherDeps.push(deps);
            return actual.createEmailDispatcher(deps);
        },
    };
});
vi.mock('../../../lib/notification/quiet-hours', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../lib/notification/quiet-hours')>()),
    isQuietHours: () => false,
}));

const mockSessionOpen = vi.fn();
vi.mock('@y0ngha/siglens-core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@y0ngha/siglens-core')>()),
    isEtRegularSessionOpen: (...a: unknown[]) => mockSessionOpen(...a),
}));

import { GET as handler, isInDecisionWindow } from '../execute';
import { etDayStart } from '../../../lib/analysis/daily-bars';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 2026-01-05(월, EST) 15:47 ET — 판단 창 안. */
const DECISION_NOW = new Date('2026-01-05T20:47:00Z');
/** 같은 날 11:07 ET — 판단 창 밖. */
const RISK_NOW = new Date('2026-01-05T16:07:00Z');

/** 달력일로 날짜를 찍은 일봉. 마지막 봉 날짜 = `lastDate`. */
function series(closes: number[], lastDate = '2026-01-05'): DailyBar[] {
    const end = Date.parse(lastDate);
    return closes.map((c, i) => ({
        date: new Date(end - (closes.length - 1 - i) * 86_400_000).toISOString().slice(0, 10),
        open: c,
        high: c + 1,
        low: c - 1,
        close: c,
    }));
}
const rising = (n = 260, from = 100, step = 0.2) =>
    Array.from({ length: n }, (_, i) => from + i * step);
/** 200일선 위에서 사흘 급락 — RSI(2) ≈ 0, 종가 > SMA200. */
const dipAbove = (drop = 3) => {
    const c = rising();
    const last = c[c.length - 1]!;
    return [...c.slice(0, -3), last - drop, last - 2 * drop, last - 3 * drop];
};
/** 하락 추세 — SPY 국면 off. */
const falling = () => Array.from({ length: 260 }, (_, i) => 200 - i * 0.2);

type BarsMap = Record<string, number[] | null>;
function setBars(map: BarsMap) {
    mockFetchDailyBars.mockImplementation(async (sym) => (map[sym] ? series(map[sym]!) : null));
}
function setQuotes(
    prices: Record<string, number | null>,
    previousClose: Record<string, number> = {},
) {
    mockQuote.mockImplementation(async (sym: string) => ({
        source: 'fmp_quote',
        price: prices[sym] ?? null,
        previousClose: previousClose[sym] ?? null,
    }));
}
const lastOf = (c: number[]) => c[c.length - 1]!;

let config: Record<string, unknown>;
const watch = (...symbols: string[]) =>
    q.getEnabledWatchlist.mockResolvedValue(
        symbols.map((s) => ({ symbol: s, companyName: s, enabled: true })),
    );
const position = (o: Partial<Record<string, unknown>> = {}) => ({
    id: 1,
    symbol: 'NVDA',
    side: 'long',
    quantity: 10,
    avgPrice: '100',
    stopPrice: '90',
    openedAt: new Date('2026-01-02T20:47:00Z'),
    status: 'open',
    ...o,
});

async function run(now: Date) {
    vi.setSystemTime(now);
    const res = await handler(new Request('https://x/api/cron/execute'));
    return (await res.json()) as Record<string, unknown>;
}
const decisionsOf = () =>
    (q.insertCronDecisions.mock.calls.at(-1)?.[3] ?? []) as Array<Record<string, unknown>>;
const actions = () => decisionsOf().map((d) => `${d.symbol ?? '-'}:${d.action}`);
const summary = () => q.finishCronRun.mock.calls.at(-1)?.[2]?.summary as Record<string, unknown>;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.clearAllMocks();
    config = {
        trading_enabled: true,
        trading_mode: 'dry_run',
        max_trades_per_day: 20,
    };
    q.getConfigValue.mockImplementation(async (_db: unknown, key: string) => config[key] ?? null);
    for (const fn of [
        q.startCronRun,
        q.finishCronRun,
        q.finalizeStaleCronRuns,
        q.insertCronDecisions,
        q.expireOldPendingOrders,
        q.enqueueNotification,
    ]) {
        fn.mockResolvedValue(undefined);
    }
    q.getOpenPositions.mockResolvedValue([]);
    q.getPendingOrders.mockResolvedValue([]);
    q.getTodayTradeCount.mockResolvedValue(0);
    q.getTodayInflightOrderCount.mockResolvedValue(0);
    q.getTodayRealizedPnl.mockResolvedValue(0);
    q.getNeedsReviewSymbols.mockResolvedValue([]);
    q.getPendingSubmittedOrders.mockResolvedValue([]);
    q.getNotificationConfig.mockResolvedValue([
        { channel: 'email', enabled: true, target: 'a@b.c', events: ['error', 'trade_executed'] },
    ]);
    q.hasDecisionPhaseSince.mockResolvedValue(false);
    q.setPositionStopPrice.mockResolvedValue(true);
    q.getNoPriceStreak.mockResolvedValue(0);
    q.getSymbolsSoldSince.mockResolvedValue(new Set());
    q.getLatestSizing.mockResolvedValue(null);
    q.getFirstSoftRegimeActiveSince.mockResolvedValue(null);
    watch();
    mockCash.mockResolvedValue(25000);
    mockClaimOnce.mockResolvedValue(true);
    mockLock.mockResolvedValue({ token: 't' });
    mockSessionOpen.mockReturnValue(true);
    mockIsUsMarketOpen.mockResolvedValue(true);
    mockExecuteEntry.mockResolvedValue({ executed: true, exposureDelta: 5000, cashDebit: 5000 });
    mockExecuteExit.mockResolvedValue({ executed: true, exposureDelta: -1000, cashDebit: 0 });
    setBars({ SPY: rising() });
    setQuotes({ SPY: lastOf(rising()) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------

describe('decision window', () => {
    it('is the last 20 minutes before the close, early closes included', () => {
        expect(isInDecisionWindow(new Date('2026-01-05T20:47:00Z'))).toBe(true); // 15:47 ET
        expect(isInDecisionWindow(new Date('2026-01-05T20:35:00Z'))).toBe(false); // 15:35 ET
        expect(isInDecisionWindow(new Date('2026-01-05T21:05:00Z'))).toBe(false); // after the bell
        // 2026-11-27 (day after Thanksgiving) closes 13:00 ET → 12:47 ET is inside.
        expect(isInDecisionWindow(new Date('2026-11-27T17:47:00Z'))).toBe(true);
        expect(isInDecisionWindow(new Date('2026-01-03T20:47:00Z'))).toBe(false); // Saturday
    });

    it('etDayStart is ET midnight in both EST and EDT', () => {
        expect(etDayStart(new Date('2026-01-05T20:47:00Z')).toISOString()).toBe(
            '2026-01-05T05:00:00.000Z',
        );
        expect(etDayStart(new Date('2026-07-06T19:47:00Z')).toISOString()).toBe(
            '2026-07-06T04:00:00.000Z',
        );
    });
});

describe('idle ticks leave no audit row (§4.1)', () => {
    it('outside the window with nothing held', async () => {
        const body = await run(RISK_NOW);
        expect(body).toEqual({ skipped: true, reason: 'idle' });
        expect(q.startCronRun).not.toHaveBeenCalled();
    });

    it('in the window when today’s decision is already done and nothing is held', async () => {
        q.hasDecisionPhaseSince.mockResolvedValue(true);
        expect(await run(DECISION_NOW)).toEqual({ skipped: true, reason: 'idle' });
        expect(q.hasDecisionPhaseSince).toHaveBeenCalledWith(
            fakeDb,
            new Date('2026-01-05T05:00:00Z'),
        );
        expect(q.startCronRun).not.toHaveBeenCalled();
    });
});

describe('risk phase — every tick', () => {
    it('fires the disaster stop at or below stop_price, whole position, stop-loss event', async () => {
        q.getOpenPositions.mockResolvedValue([position()]);
        setQuotes({ NVDA: 89.5 });
        await run(RISK_NOW);
        expect(mockExecuteExit).toHaveBeenCalledWith(
            expect.objectContaining({ tradingMode: 'dry_run' }),
            expect.objectContaining({ quantity: 10, price: 89.5, isStopLoss: true }),
        );
        expect(actions()).toEqual(['NVDA:mr_stop_atr']);
    });

    it('does nothing above the stop outside the decision window', async () => {
        q.getOpenPositions.mockResolvedValue([position()]);
        setQuotes({ NVDA: 95 });
        await run(RISK_NOW);
        expect(mockExecuteExit).not.toHaveBeenCalled();
        expect(actions()).toEqual([]);
        expect(summary()).toMatchObject({ decisionTick: false });
        expect(summary().decisionPhase).toBeUndefined();
    });

    it('fills an empty stop_price from ATR up to the day before entry', async () => {
        q.getOpenPositions.mockResolvedValue([
            position({ stopPrice: null, openedAt: new Date('2026-01-05T15:00:00Z') }),
        ]);
        setBars({ NVDA: Array(260).fill(100) }); // constant range ±1 → ATR 2
        setQuotes({ NVDA: 95 });
        await run(RISK_NOW);
        expect(q.setPositionStopPrice).toHaveBeenCalledWith(fakeDb, 1, 80); // 100 − 10 × 2
        expect(summary()).toMatchObject({ stopBackfilled: 1 });
    });

    it('skips a position that already has a sell in flight', async () => {
        q.getOpenPositions.mockResolvedValue([position()]);
        q.getPendingSubmittedOrders.mockResolvedValue([
            { symbol: 'NVDA', side: 'sell', status: 'submitted', quantity: 10 },
        ]);
        setQuotes({ NVDA: 50 });
        await run(RISK_NOW);
        expect(mockExecuteExit).not.toHaveBeenCalled();
        expect(actions()).toEqual(['NVDA:pending_sell_in_progress']);
    });

    it('no price → skipped_no_price with one mail per day', async () => {
        q.getOpenPositions.mockResolvedValue([position()]);
        setQuotes({});
        await run(RISK_NOW);
        expect(actions()).toEqual(['NVDA:skipped_no_price']);
        expect(mockClaimOnce).toHaveBeenCalledWith('mail:no-price-NVDA:2026-01-05', 86_400);
    });

    it('kill switch stops everything, exits included', async () => {
        config.trading_enabled = false;
        q.getOpenPositions.mockResolvedValue([position()]);
        setQuotes({ NVDA: 50 });
        expect(await run(RISK_NOW)).toEqual({ skipped: true, reason: 'trading_disabled' });
        expect(mockExecuteExit).not.toHaveBeenCalled();
    });
});

describe('equity-scaled sizing — slots and caps from the account (2026-10-05 spec)', () => {
    const budgetOf = (sym = 'AAA') =>
        (
            decisionsOf().find((d) => d.symbol === sym)!.detail as {
                budget: Record<string, unknown>;
            }
        ).budget;
    const signalAAA = () => {
        watch('AAA');
        const aaa = dipAbove();
        setBars({ SPY: rising(), AAA: aaa, HLD: falling() });
        // 전일 종가 = 현재가 → 오늘 변동 0, 일일 손실 차단기를 건드리지 않는다.
        setQuotes({ SPY: lastOf(rising()), AAA: lastOf(aaa), HLD: 50 }, { HLD: 50 });
        return lastOf(aaa);
    };
    const sizingOf = () => summary().sizing as Record<string, unknown>;
    const record = (patch: Record<string, unknown> = {}) => ({
        sizing: {
            equity: 2000,
            slots: 4,
            slotsSource: 'prices',
            coverage: 0.79,
            priceCount: 39,
            slotBudget: 500,
            maxPositionSize: 500,
            maxTotalExposure: 2000,
            dailyLossLimit: 80,
            ...patch,
        },
        at: new Date('2026-01-02T20:45:00Z'),
    });

    it('equity counts held positions at the live price', async () => {
        const px = signalAAA();
        mockCash.mockResolvedValue(19000);
        // 100주 × 실시간 50 = 5,000(평단 60이 아니라) → 총자산 24,000 → 칸 3,000
        q.getOpenPositions.mockResolvedValue([
            position({ symbol: 'HLD', quantity: 100, avgPrice: '60', stopPrice: '1' }),
        ]);
        await run(DECISION_NOW);
        const args = mockExecuteEntry.mock.calls.find(
            (c) => (c[1] as { symbol: string }).symbol === 'AAA',
        )![1];
        expect(args).toMatchObject({ quantity: Math.floor(3000 / px) });
        expect(budgetOf()).toMatchObject({
            limitedBy: 'slot',
            equity: 24000,
            slots: 8,
            slotsSource: 'prices',
            coverage: 1,
            slotBudget: 3000,
        });
        expect(sizingOf()).toMatchObject({
            equity: 24000,
            slots: 8,
            slotsSource: 'prices',
            priceCount: 1,
            maxPositionSize: 3000,
            maxTotalExposure: 24000,
            dailyLossLimit: 480,
        });
    });

    it('a small account drops slots so a pricier signal still buys one share', async () => {
        // 총자산 $2,000. 감시 종목 4개 중 $500 이하가 3개 → 8칸($250)이면 커버리지 25%, 4칸($500)이면 75%.
        watch('PRI', 'C1', 'C2', 'C3');
        const pri = dipAbove(3).map((c) => c + 280); // ≈ $420, 200일선 위 눌림
        setBars({ SPY: rising(), PRI: pri, C1: falling(), C2: falling(), C3: falling() });
        setQuotes({ SPY: lastOf(rising()), PRI: lastOf(pri), C1: 450, C2: 480, C3: 900 });
        mockCash.mockResolvedValue(2000);
        await run(DECISION_NOW);
        expect(mockExecuteEntry.mock.calls[0]![1]).toMatchObject({ symbol: 'PRI', quantity: 1 });
        expect(budgetOf('PRI')).toMatchObject({ slots: 4, slotBudget: 500, coverage: 0.75 });
        expect(sizingOf()).toMatchObject({ slots: 4, dailyLossLimit: 80 });
    });

    it('stale DB keys (mr_slots, max_position_size, …) are ignored', async () => {
        const px = signalAAA();
        Object.assign(config, {
            mr_slots: 1,
            max_position_size: 1,
            max_total_exposure: 1,
            max_daily_loss_usd: 1,
        });
        q.getTodayRealizedPnl.mockResolvedValue(-100); // 옛 한도 $1이면 차단됐을 손실
        await run(DECISION_NOW);
        expect(mockExecuteEntry.mock.calls[0]![1]).toMatchObject({
            quantity: Math.floor(3125 / px),
        });
        expect(summary().entriesBlockedBy).toBeUndefined();
        expect(q.getConfigValue).not.toHaveBeenCalledWith(fakeDb, 'mr_slots');
        expect(q.getConfigValue).not.toHaveBeenCalledWith(fakeDb, 'max_daily_loss_usd');
    });

    it('an absurd equity is held by the absolute caps', async () => {
        const px = signalAAA();
        mockCash.mockResolvedValue(1e9);
        await run(DECISION_NOW);
        expect(mockExecuteEntry.mock.calls[0]![1]).toMatchObject({
            quantity: Math.floor(25_000 / px),
        });
        expect(budgetOf()).toMatchObject({ limitedBy: 'symbol' });
        expect(sizingOf()).toMatchObject({
            maxPositionSize: 25_000,
            maxTotalExposure: 110_000,
            dailyLossLimit: 4000,
        });
    });

    it('unknown cash on a decision tick → no entry, mr_data_error, the window retries', async () => {
        signalAAA();
        mockCash.mockResolvedValue(null);
        q.getLatestSizing.mockResolvedValue(record());
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toEqual(['AAA:mr_data_error']);
        const d = decisionsOf()[0]!;
        expect(d.detail).toMatchObject({ reason: 'equity_unavailable', mr: { signal: true } });
        expect(summary().decisionPhase).toBeUndefined();
        // 칸 수는 총자산 0으로 계산하지 않고 이어 쓴다 → 손실 한도는 기록의 총자산·칸 수 그대로.
        expect(sizingOf()).toMatchObject({
            equity: null,
            slots: 4,
            slotsSource: 'carried',
            dailyLossLimit: 80,
        });
    });

    it('unknown cash and no record → loss check skipped, limit null', async () => {
        signalAAA();
        mockCash.mockResolvedValue(null);
        q.getTodayRealizedPnl.mockResolvedValue(-1_000_000);
        await run(DECISION_NOW);
        expect(summary().entriesBlockedBy).toBeUndefined();
        expect(sizingOf()).toMatchObject({
            slots: 8,
            slotsSource: 'default',
            dailyLossLimit: null,
        });
        expect(actions()).toEqual(['AAA:mr_data_error']);
    });

    it('a decision tick with too few quotes carries the last K instead of guessing', async () => {
        watch('AAA', 'X1', 'X2', 'X3');
        const aaa = dipAbove();
        setBars({ SPY: rising(), AAA: aaa });
        setQuotes({ SPY: lastOf(rising()), AAA: lastOf(aaa) }); // 4개 중 1개만
        q.getLatestSizing.mockResolvedValue(record({ slots: 5 }));
        await run(DECISION_NOW);
        expect(q.getLatestSizing).toHaveBeenCalledWith(fakeDb, { pricedOnly: true });
        expect(sizingOf()).toMatchObject({ slots: 5, slotsSource: 'carried', equity: 25000 });
        expect(budgetOf()).toMatchObject({ slots: 5, slotBudget: 5000 });
    });

    it('a record lookup failure falls back to MAX_SLOTS', async () => {
        q.getOpenPositions.mockResolvedValue([position()]);
        setQuotes({ NVDA: 95 });
        q.getLatestSizing.mockRejectedValue(new Error('db down'));
        await run(RISK_NOW);
        expect(sizingOf()).toMatchObject({ slots: 8, slotsSource: 'default' });
    });

    describe('daily loss limit = 16% of a slot', () => {
        // 총자산 = 현금 1,500 + NVDA 10주 × 50 = 2,000. 전일 종가 = 현재가 → 미실현 변동 0.
        const riskTick = async (pnl: number) => {
            q.getOpenPositions.mockResolvedValue([position({ avgPrice: '50', stopPrice: '1' })]);
            setQuotes({ NVDA: 50 }, { NVDA: 50 });
            mockCash.mockResolvedValue(1500);
            q.getTodayRealizedPnl.mockResolvedValue(pnl);
            await run(RISK_NOW);
            return summary();
        };

        it('a risk tick carries the last decision’s K: 2,000 ÷ 4 × 16% = 80', async () => {
            q.getLatestSizing.mockResolvedValue(record());
            expect(await riskTick(-79.99)).not.toHaveProperty('entriesBlockedBy');
            expect(sizingOf()).toMatchObject({
                slots: 4,
                slotsSource: 'carried',
                dailyLossLimit: 80,
            });
            expect(await riskTick(-80.01)).toMatchObject({ entriesBlockedBy: 'daily_loss_limit' });
        });

        it('no record yet → K = 8, the strict limit: 2,000 ÷ 8 × 16% = 40', async () => {
            expect(await riskTick(-39.99)).not.toHaveProperty('entriesBlockedBy');
            expect(sizingOf()).toMatchObject({
                slots: 8,
                slotsSource: 'default',
                dailyLossLimit: 40,
            });
            expect(await riskTick(-40.01)).toMatchObject({ entriesBlockedBy: 'daily_loss_limit' });
        });

        it('unknown cash on a risk tick uses the record’s equity', async () => {
            q.getLatestSizing.mockResolvedValue(record({ equity: 4000 }));
            q.getOpenPositions.mockResolvedValue([position({ avgPrice: '50', stopPrice: '1' })]);
            setQuotes({ NVDA: 50 }, { NVDA: 50 });
            mockCash.mockResolvedValue(null);
            q.getTodayRealizedPnl.mockResolvedValue(-161);
            await run(RISK_NOW);
            // 4,000 ÷ 4 × 16% = 160
            expect(summary()).toMatchObject({ entriesBlockedBy: 'daily_loss_limit' });
            expect(sizingOf()).toMatchObject({ equity: null, dailyLossLimit: 160 });
        });
    });
});

describe('decision phase — entries', () => {
    it('buys a signal: RSI(2) dip above SMA200 in an up regime, stop from ATR', async () => {
        watch('NVDA');
        const nvda = dipAbove();
        setBars({ SPY: rising(), NVDA: nvda });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(nvda) });
        await run(DECISION_NOW);
        const [, args] = mockExecuteEntry.mock.calls[0]!;
        expect(args).toMatchObject({
            symbol: 'NVDA',
            // 칸 예산 = 총자산 25,000 ÷ 기본 8칸 (§3.1)
            quantity: Math.floor(25000 / 8 / lastOf(nvda)),
            price: lastOf(nvda),
        });
        // 손절 = 진입가 − 기본 10 × ATR(14, 오늘 봉 제외)
        const atrPrev = wilderAtr(series(nvda).slice(0, -1), 14)!;
        expect((args as { stopPrice: number }).stopPrice).toBeCloseTo(
            lastOf(nvda) - 10 * atrPrev,
            6,
        );
        expect(actions()).toEqual(['NVDA:mr_buy']);
        const d = decisionsOf()[0]!;
        expect((d.detail as { mr: { rank: number } }).mr.rank).toBe(1);
        expect(summary()).toMatchObject({ decisionTick: true, decisionPhase: 'done' });
    });

    it('ranks signals by RSI(2) and skips what the budget cannot fund', async () => {
        // 첫 매수가 현금을 다 쓴다 → 둘째는 현금 부족.
        mockExecuteEntry.mockResolvedValue({
            executed: true,
            exposureDelta: 3125,
            cashDebit: 25000,
        });
        watch('AAA', 'BBB');
        const deep = dipAbove(4); // deeper dip → lower RSI2
        const shallow = dipAbove(2);
        setBars({ SPY: rising(), AAA: shallow, BBB: deep });
        setQuotes({ SPY: lastOf(rising()), AAA: lastOf(shallow), BBB: lastOf(deep) });
        await run(DECISION_NOW);
        expect(mockExecuteEntry).toHaveBeenCalledTimes(1);
        expect(mockExecuteEntry.mock.calls[0]![1]).toMatchObject({ symbol: 'BBB' });
        expect(actions()).toEqual(['BBB:mr_buy', 'AAA:mr_skip_budget']);
    });

    it('regime off → one mr_regime_off row and no entries', async () => {
        watch('NVDA');
        setBars({ SPY: falling(), NVDA: dipAbove() });
        setQuotes({ SPY: lastOf(falling()), NVDA: lastOf(dipAbove()) });
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toEqual(['-:mr_regime_off']);
    });

    it('SPY unreadable → fail closed with one mr_data_error', async () => {
        watch('NVDA');
        setBars({ SPY: null, NVDA: dipAbove() });
        setQuotes({ NVDA: lastOf(dipAbove()) });
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toEqual(['SPY:mr_data_error']);
    });

    it('no live price → mr_data_error, never a signal from yesterday’s close', async () => {
        watch('NVDA');
        setBars({ SPY: rising(), NVDA: dipAbove() });
        setQuotes({ SPY: lastOf(rising()) });
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toEqual(['NVDA:mr_data_error']);
    });

    it('a quote far from the previous close is used only when a re-fetch agrees', async () => {
        watch('NVDA');
        const px = lastOf(dipAbove());
        setBars({ SPY: rising(), NVDA: dipAbove() });
        // Real 40% gap down: both fetches agree → the signal stands.
        setQuotes({ SPY: lastOf(rising()), NVDA: px }, { NVDA: px / 0.6 });
        await run(DECISION_NOW);
        expect(mockExecuteEntry).toHaveBeenCalled();

        // Corrupt tick: the re-fetch disagrees → no price for this tick, no buy.
        mockExecuteEntry.mockClear();
        let nvdaCalls = 0;
        mockQuote.mockImplementation(async (sym: string) =>
            sym === 'NVDA'
                ? {
                      source: 'fmp_quote',
                      price: nvdaCalls++ === 0 ? px : px / 0.6,
                      previousClose: px / 0.6,
                  }
                : { source: 'fmp_quote', price: lastOf(rising()), previousClose: null },
        );
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toEqual(['NVDA:mr_data_error']);
    });

    it('in-flight buy or needs_review blocks a repeat buy (decision retry idempotency)', async () => {
        watch('NVDA', 'TSLA');
        setBars({ SPY: rising(), NVDA: dipAbove(), TSLA: dipAbove(4) });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(dipAbove()), TSLA: lastOf(dipAbove(4)) });
        q.getPendingSubmittedOrders.mockResolvedValue([
            { symbol: 'NVDA', side: 'buy', status: 'error', quantity: 1 },
        ]);
        q.getNeedsReviewSymbols.mockResolvedValue(['TSLA']);
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions().sort()).toEqual([
            'NVDA:pending_order_in_progress',
            'TSLA:pending_order_in_progress',
        ]);
    });

    it('a non-signal symbol is recorded as mr_hold with its reading', async () => {
        watch('MSFT');
        setBars({ SPY: rising(), MSFT: rising() });
        setQuotes({ SPY: lastOf(rising()), MSFT: lastOf(rising()) });
        await run(DECISION_NOW);
        expect(actions()).toEqual(['MSFT:mr_hold']);
        expect((decisionsOf()[0]!.detail as { mr: { rsi2: number } }).mr.rsi2).toBe(100);
    });

    it('does not re-buy a symbol it holds', async () => {
        watch('NVDA');
        q.getOpenPositions.mockResolvedValue([
            position({ openedAt: new Date('2026-01-05T15:00:00Z') }),
        ]);
        setBars({ SPY: rising(), NVDA: dipAbove() });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(dipAbove()) });
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toEqual(['NVDA:mr_hold']); // entry day: no rule exit, no entry
    });
});

describe('decision phase — rule exits', () => {
    it('MA5 reclaim sells the whole position', async () => {
        q.getOpenPositions.mockResolvedValue([position({ stopPrice: '1' })]);
        setBars({ SPY: rising(), NVDA: rising() }); // price above SMA5
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(rising()) });
        await run(DECISION_NOW);
        expect(mockExecuteExit.mock.calls[0]![1]).toMatchObject({
            quantity: 10,
            isStopLoss: false,
        });
        expect(actions()).toEqual(['NVDA:mr_exit_ma5']);
    });

    it('time stop after maxHoldDays even below MA5', async () => {
        const nvda = dipAbove();
        q.getOpenPositions.mockResolvedValue([
            position({ stopPrice: '1', openedAt: new Date('2025-12-20T20:47:00Z') }),
        ]);
        setBars({ SPY: rising(), NVDA: nvda });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(nvda) });
        await run(DECISION_NOW);
        expect(actions()).toEqual(['NVDA:mr_exit_time']);
    });

    it('a symbol sold this run is not bought back the same day', async () => {
        watch('NVDA');
        q.getOpenPositions.mockResolvedValue([position({ stopPrice: '1' })]);
        setBars({ SPY: rising(), NVDA: rising() });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(rising()) });
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
    });

    it('bars missing: data error, even while the loss breaker is up — never a forced sell', async () => {
        q.getOpenPositions.mockResolvedValue([position({ stopPrice: '1' })]);
        setBars({ SPY: rising(), NVDA: null });
        setQuotes({ SPY: lastOf(rising()), NVDA: 95 });
        await run(DECISION_NOW);
        expect(actions()).toEqual(['NVDA:mr_data_error']);

        config.trading_mode = 'auto';
        q.getTodayRealizedPnl.mockResolvedValue(-600);
        await run(DECISION_NOW);
        expect(actions()).toEqual(['NVDA:mr_data_error']);
        expect(mockExecuteExit).not.toHaveBeenCalled();
        expect(summary().decisionPhase).toBeUndefined(); // the next tick in the window retries
    });
});

describe('daily loss breaker — today’s change (§4.5)', () => {
    it('blocks entries on today’s drop, not on an old cumulative loss', async () => {
        watch('TSLA');
        const tsla = dipAbove();
        setBars({ SPY: rising(), TSLA: tsla, NVDA: rising() });
        // NVDA held since 01-02 at 100, now 50 (cumulative −500) but flat today (prev close 50).
        q.getOpenPositions.mockResolvedValue([position({ quantity: 10, stopPrice: '1' })]);
        setQuotes({ SPY: lastOf(rising()), TSLA: lastOf(tsla), NVDA: 50 }, { NVDA: 50 });
        await run(DECISION_NOW);
        expect(mockExecuteEntry).toHaveBeenCalledWith(
            expect.objectContaining({ tradingMode: 'dry_run' }),
            expect.objectContaining({ symbol: 'TSLA' }),
        );

        // Today −20% on 30 shares = −$600 → entries become mr_skip_breaker; mail goes once per day.
        mockExecuteEntry.mockClear();
        setQuotes({ SPY: lastOf(rising()), TSLA: lastOf(tsla), NVDA: 80 }, { NVDA: 100 });
        q.getOpenPositions.mockResolvedValue([position({ quantity: 30, stopPrice: '1' })]);
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toContain('TSLA:mr_skip_breaker');
        expect(mockClaimOnce).toHaveBeenCalledWith('mail:daily-loss:2026-01-05', 86_400);
        expect(summary()).toMatchObject({ exitOnly: true, entriesBlockedBy: 'daily_loss_limit' });
    });

    it('a position opened today is measured against its entry price, not previous close (T1)', async () => {
        watch('TSLA');
        const tsla = dipAbove();
        setBars({ SPY: rising(), TSLA: tsla, NVDA: rising() });
        // avgPrice 100, live 80, previousClose 80, qty 30 → flat vs previousClose but −$600 vs entry.
        setQuotes({ SPY: lastOf(rising()), TSLA: lastOf(tsla), NVDA: 80 }, { NVDA: 80 });
        q.getOpenPositions.mockResolvedValue([
            position({
                quantity: 30,
                avgPrice: '100',
                stopPrice: '1',
                openedAt: new Date('2026-01-02T20:47:00Z'),
            }),
        ]);
        await run(DECISION_NOW);
        expect(mockExecuteEntry).toHaveBeenCalled(); // opened previous day → reference is previousClose (flat)

        mockExecuteEntry.mockClear();
        q.getOpenPositions.mockResolvedValue([
            position({ quantity: 30, avgPrice: '100', stopPrice: '1', openedAt: DECISION_NOW }),
        ]);
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled(); // opened today → reference is the entry price
        expect(actions()).toContain('TSLA:mr_skip_breaker');
    });

    it('a second breach the same day sends no second mail', async () => {
        q.getOpenPositions.mockResolvedValue([position({ quantity: 30, stopPrice: '1' })]);
        setQuotes({ NVDA: 80 }, { NVDA: 100 });
        mockClaimOnce.mockResolvedValue(false);
        await run(RISK_NOW);
        expect(mockClaimOnce).toHaveBeenCalledWith('mail:daily-loss:2026-01-05', 86_400);
        expect(mockSendError).not.toHaveBeenCalled();
        expect(summary()).toMatchObject({ exitOnly: true, entriesBlockedBy: 'daily_loss_limit' });
    });

    it('a >25% quote spike upward is treated as a corrupt tick, not a gain (mailed once)', async () => {
        q.getOpenPositions.mockResolvedValue([position({ quantity: 30, stopPrice: '1' })]);
        setQuotes({ NVDA: 200 }, { NVDA: 100 });
        await run(RISK_NOW);
        expect(summary().entriesBlockedBy).toBeUndefined();
        expect(summary().exitOnly).toBeUndefined();
        expect(mockClaimOnce).toHaveBeenCalledWith('mail:quote-divergence:2026-01-05', 86_400);
    });

    it('a >25% quote drop still counts as a loss — a corrupt-looking spike must not mask a real crash (A8)', async () => {
        q.getOpenPositions.mockResolvedValue([position({ quantity: 30, stopPrice: '1' })]);
        setQuotes({ NVDA: 40 }, { NVDA: 100 });
        await run(RISK_NOW);
        expect(summary()).toMatchObject({ exitOnly: true, entriesBlockedBy: 'daily_loss_limit' });
        expect(mockClaimOnce).toHaveBeenCalledWith('mail:quote-divergence:2026-01-05', 86_400);
        expect(mockClaimOnce).toHaveBeenCalledWith('mail:daily-loss:2026-01-05', 86_400);
    });
});

describe('modes and guards', () => {
    it('an unknown trading_mode is treated as dry_run', async () => {
        config.trading_mode = 'Auto';
        watch('NVDA');
        setBars({ SPY: rising(), NVDA: dipAbove() });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(dipAbove()) });
        await run(DECISION_NOW);
        expect(mockExecuteEntry.mock.calls[0]![0]).toMatchObject({ tradingMode: 'dry_run' });
        expect(mockIsUsMarketOpen).not.toHaveBeenCalled();
    });

    it('passes the configured digest hour to the mail dispatcher', async () => {
        config.digest_hour_kst = 7;
        dispatcherDeps.length = 0;
        q.getOpenPositions.mockResolvedValue([position()]);
        await run(RISK_NOW);
        expect(dispatcherDeps.at(-1)?.digestHour).toBe(7);
    });

    it('live modes ask the broker for unscheduled closures', async () => {
        config.trading_mode = 'auto';
        mockIsUsMarketOpen.mockResolvedValue(false);
        q.getOpenPositions.mockResolvedValue([position()]);
        expect(await run(RISK_NOW)).toEqual({ skipped: true, reason: 'us-market-holiday' });
    });

    it('asks the broker about the ET trading day, not the KST date of the decision tick', async () => {
        // 15:47 ET 월요일 = 화요일 05:47 KST — 브로커에는 미국 날짜(월요일)를 넘긴다.
        config.trading_mode = 'auto';
        q.getOpenPositions.mockResolvedValue([position()]);
        await run(DECISION_NOW);
        expect(mockIsUsMarketOpen).toHaveBeenCalledWith('2026-01-05');
    });

    it('records cash and exposure consumption across entries in one run', async () => {
        watch('AAA', 'BBB');
        setBars({ SPY: rising(), AAA: dipAbove(3), BBB: dipAbove(4) });
        setQuotes({ SPY: lastOf(rising()), AAA: lastOf(dipAbove(3)), BBB: lastOf(dipAbove(4)) });
        mockCash.mockResolvedValue(6000);
        await run(DECISION_NOW);
        // first buy spends 5,000 of 6,000 → the second is limited by cash, not skipped
        expect(mockExecuteEntry).toHaveBeenCalledTimes(2);
        expect(mockExecuteEntry.mock.calls[1]![1]).toMatchObject({ remainingBuyingPower: 1000 });
    });
});

describe('run-level outcomes', () => {
    it('market closed (holiday / early bell) → skipped row', async () => {
        mockSessionOpen.mockReturnValue(false);
        q.getOpenPositions.mockResolvedValue([position()]);
        expect(await run(RISK_NOW)).toEqual({ skipped: true, reason: 'market_closed' });
        expect(q.finishCronRun.mock.calls.at(-1)![2]).toMatchObject({
            status: 'skipped',
            outcome: 'market_closed',
        });
    });

    it('lock contention is skipped, a lock backend outage is an error', async () => {
        q.getOpenPositions.mockResolvedValue([position()]);
        mockLock.mockResolvedValue({ token: null, reason: 'contended' });
        await run(RISK_NOW);
        expect(q.finishCronRun.mock.calls.at(-1)![2]).toMatchObject({
            status: 'skipped',
            outcome: 'locked',
        });
        mockLock.mockResolvedValue({ token: null, reason: 'unavailable' });
        await run(RISK_NOW);
        expect(q.finishCronRun.mock.calls.at(-1)![2]).toMatchObject({
            status: 'error',
            outcome: 'locked',
        });
    });

    it('broker calendar failure blocks entries but still runs exits (stops), with a mail', async () => {
        config.trading_mode = 'auto';
        q.getOpenPositions.mockResolvedValue([position({ stopPrice: '80' })]);
        setQuotes({ NVDA: 70 }, { NVDA: 96 });
        mockIsUsMarketOpen.mockRejectedValue(new Error('toss down'));
        await run(RISK_NOW);
        expect(actions()).toEqual(['NVDA:mr_stop_atr']);
        expect(summary().entriesBlockedBy).toBe('market_status_unavailable');
        expect(mockSendError).toHaveBeenCalled();
    });

    it('broker calendar failure on the decision tick: no entries, decision not marked done', async () => {
        config.trading_mode = 'auto';
        watch('NVDA');
        setBars({ SPY: rising(), NVDA: dipAbove() });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(dipAbove()) });
        mockIsUsMarketOpen.mockRejectedValue(new Error('toss down'));
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toEqual(['NVDA:mr_skip_breaker']);
        expect(summary().decisionPhase).toBeUndefined();
    });

    it('a held position without a live price makes this tick’s equity unknown — no inflated limit', async () => {
        q.getOpenPositions.mockResolvedValue([position({ quantity: 10, avgPrice: '100' })]);
        setQuotes({});
        await run(RISK_NOW);
        expect(
            (summary().sizing as Record<string, unknown> | undefined)?.equity ?? null,
        ).toBeNull();
    });

    it('trade limit with nothing held outside the window is a plain skip', async () => {
        q.getOpenPositions.mockResolvedValueOnce([position()]).mockResolvedValue([]);
        q.getTodayTradeCount.mockResolvedValue(20);
        expect(await run(RISK_NOW)).toEqual({ skipped: true, reason: 'daily_trade_limit_reached' });
    });

    it('semi_auto: an unanswered approval for the symbol blocks a second one', async () => {
        config.trading_mode = 'semi_auto';
        watch('NVDA');
        setBars({ SPY: rising(), NVDA: dipAbove() });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(dipAbove()) });
        q.getPendingOrders.mockResolvedValue([
            { symbol: 'NVDA', side: 'buy', status: 'pending', quantity: 1, priceLimit: '100' },
        ]);
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toEqual(['NVDA:pending_exists']);
    });

    it('auto under the loss breaker liquidates a priceless position only after consecutive misses', async () => {
        config.trading_mode = 'auto';
        // No live price → this tick's equity is unknown; the loss limit comes from the last record.
        q.getLatestSizing.mockResolvedValue({
            sizing: { equity: 2000, slots: 4, dailyLossLimit: 80 },
            at: new Date('2026-01-02T20:45:00Z'),
        });
        q.getTodayRealizedPnl.mockResolvedValue(-600);
        q.getOpenPositions.mockResolvedValue([position()]);
        setQuotes({});

        // 2026-10-16: one tick of FMP 429 sold three positions. A first miss only records the gap.
        await run(RISK_NOW);
        expect(mockExecuteExit).not.toHaveBeenCalled();
        expect(actions()).toEqual(['NVDA:skipped_no_price']);
        expect(decisionsOf()[0]!.detail).toMatchObject({ noPriceStreak: 1 });
        expect(q.getNoPriceStreak).toHaveBeenCalledWith(
            fakeDb,
            'NVDA',
            expect.stringMatching(/^exec-/),
            expect.any(Date),
            2,
        );

        q.getNoPriceStreak.mockResolvedValue(1);
        await run(RISK_NOW);
        expect(mockExecuteExit).not.toHaveBeenCalled();
        expect(decisionsOf()[0]!.detail).toMatchObject({ noPriceStreak: 2 });

        q.getNoPriceStreak.mockResolvedValue(2);
        await run(RISK_NOW);
        expect(actions()).toEqual(['NVDA:mr_forced_exit']);
    });

    it('a streak lookup failure holds the forced exit (fail toward not selling on missing data)', async () => {
        config.trading_mode = 'auto';
        q.getTodayRealizedPnl.mockResolvedValue(-600);
        q.getOpenPositions.mockResolvedValue([position()]);
        setQuotes({});
        q.getNoPriceStreak.mockRejectedValue(new Error('db down'));
        await run(RISK_NOW);
        expect(mockExecuteExit).not.toHaveBeenCalled();
        expect(actions()).toEqual(['NVDA:skipped_no_price']);
    });

    it('a failed quote is fetched once more after a pause — a transient 429 does not leave a gap', async () => {
        config.trading_mode = 'auto';
        q.getTodayRealizedPnl.mockResolvedValue(-600);
        q.getOpenPositions.mockResolvedValue([position({ stopPrice: '1' })]);
        mockQuote
            .mockResolvedValueOnce({ source: 'fmp_quote', price: null, reason: 'request_failed' })
            .mockResolvedValue({ source: 'fmp_quote', price: 95, previousClose: 96 });
        await run(RISK_NOW);
        expect(mockQuote).toHaveBeenCalledTimes(2);
        expect(mockExecuteExit).not.toHaveBeenCalled();
        expect(actions()).toEqual([]);
    });

    it('a stop hit on one quote is re-checked; a recovered re-fetch holds the position', async () => {
        q.getOpenPositions.mockResolvedValue([position({ stopPrice: '80' })]);
        mockQuote
            .mockResolvedValueOnce({ source: 'fmp_quote', price: 8, previousClose: 96 }) // bogus tick
            .mockResolvedValue({ source: 'fmp_quote', price: 95, previousClose: 96 });
        await run(RISK_NOW);
        expect(mockExecuteExit).not.toHaveBeenCalled();
        expect(actions()).toEqual(['NVDA:stop_unconfirmed']);
        expect(mockSendError).toHaveBeenCalled();
    });

    it('a stop hit confirmed by the re-fetch (or a failed re-fetch) sells', async () => {
        q.getOpenPositions.mockResolvedValue([position({ stopPrice: '80' })]);
        setQuotes({ NVDA: 70 }, { NVDA: 96 });
        await run(RISK_NOW);
        expect(actions()).toEqual(['NVDA:mr_stop_atr']);

        mockExecuteExit.mockClear();
        mockQuote
            .mockReset()
            .mockResolvedValueOnce({ source: 'fmp_quote', price: 70, previousClose: 96 })
            .mockRejectedValue(new Error('fmp down'));
        await run(RISK_NOW);
        expect(actions()).toEqual(['NVDA:mr_stop_atr']);
    });

    it('a per-symbol exception is recorded and mailed without stopping the run', async () => {
        q.getOpenPositions.mockResolvedValue([position(), position({ id: 2, symbol: 'TSLA' })]);
        setQuotes({ NVDA: 50, TSLA: 50 });
        mockExecuteExit.mockRejectedValueOnce(new Error('boom'));
        await run(RISK_NOW);
        expect(actions()).toEqual(['NVDA:error', 'TSLA:mr_stop_atr']);
        expect(mockSendError).toHaveBeenCalled();
    });

    it('the kill switch flipped mid-run stops the next order', async () => {
        watch('NVDA');
        setBars({ SPY: rising(), NVDA: dipAbove() });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(dipAbove()) });
        let reads = 0;
        q.getConfigValue.mockImplementation(async (_db: unknown, key: string) =>
            key === 'trading_enabled' ? ++reads === 1 : (config[key] ?? null),
        );
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toEqual(['NVDA:trading_disabled_mid_loop']);
    });

    it('an order outcome other than a fill is recorded under its own action', async () => {
        watch('NVDA');
        setBars({ SPY: rising(), NVDA: dipAbove() });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(dipAbove()) });
        mockExecuteEntry.mockResolvedValue({
            executed: false,
            action: 'order_rejected',
            order: { status: 'rejected' },
            exposureDelta: 0,
            cashDebit: 0,
        });
        await run(DECISION_NOW);
        expect(actions()).toEqual(['NVDA:order_rejected']);
        expect(decisionsOf()[0]!.detail).toMatchObject({ order: { status: 'rejected' } });
    });
});

describe('A1 — no re-buy on the exit day, even across runs', () => {
    it('a symbol sold by an earlier run today is not bought back this tick', async () => {
        watch('NVDA');
        setBars({ SPY: rising(), NVDA: dipAbove() });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(dipAbove()) });
        q.getSymbolsSoldSince.mockResolvedValue(new Set(['NVDA']));
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toEqual(['NVDA:mr_hold']);
        expect((decisionsOf()[0]!.detail as { mr: { reason: string } }).mr.reason).toBe(
            'sold_today',
        );
        expect(q.getSymbolsSoldSince).toHaveBeenCalledWith(
            fakeDb,
            new Date('2026-01-05T05:00:00Z'),
        );
    });

    it('fails closed for entries when the sold-today query throws, exits unaffected', async () => {
        watch('NVDA');
        q.getOpenPositions.mockResolvedValue([position({ symbol: 'TSLA', stopPrice: '1' })]);
        setBars({ SPY: rising(), NVDA: dipAbove(), TSLA: rising() });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(dipAbove()), TSLA: lastOf(rising()) });
        q.getSymbolsSoldSince.mockRejectedValue(new Error('db down'));
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toContain('-:mr_data_error');
        // the held TSLA rule exit still runs — the failure only blocks entries.
        expect(mockExecuteExit).toHaveBeenCalled();
    });

    it('records the failure even with no entry candidates, so decisionPhase is not marked done', async () => {
        // The one watchlist symbol is already held, so notHeldOrExited is empty —
        // the mr_data_error row must not be gated on candidate count.
        watch('NVDA');
        q.getOpenPositions.mockResolvedValue([position({ symbol: 'NVDA', stopPrice: '1' })]);
        setBars({ SPY: rising(), NVDA: rising() });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(rising()) });
        q.getSymbolsSoldSince.mockRejectedValue(new Error('db down'));
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toContain('-:mr_data_error');
        expect(decisionsOf()).toContainEqual(
            expect.objectContaining({
                action: 'mr_data_error',
                detail: expect.objectContaining({ reason: 'sold_today_query_failed' }),
            }),
        );
        expect(summary().decisionPhase).toBeUndefined();
    });
});

describe('A2 — SPY bars present but no live price fails closed on entries', () => {
    it('treats a missing SPY live price as regime unavailable, not yesterday’s close', async () => {
        watch('NVDA');
        // SPY has bars (yesterday's EOD series) but no live quote today.
        setBars({ SPY: rising(), NVDA: dipAbove() });
        setQuotes({ NVDA: lastOf(dipAbove()) });
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toEqual(['SPY:mr_data_error']);
    });
});

describe('A4 — mr_stop_atr = 0 disables new stops without touching existing ones', () => {
    it('does not fetch bars or set a stop when mr_stop_atr is 0', async () => {
        config.mr_stop_atr = 0;
        q.getOpenPositions.mockResolvedValue([position({ stopPrice: null })]);
        setQuotes({ NVDA: 95 });
        await run(RISK_NOW);
        expect(mockFetchDailyBars).not.toHaveBeenCalled();
        expect(q.setPositionStopPrice).not.toHaveBeenCalled();
    });
});

describe('A6 — silent stop backfill failure', () => {
    it('records stop_backfill_failed and mails once per day when bars are unavailable', async () => {
        q.getOpenPositions.mockResolvedValue([
            position({ stopPrice: null, openedAt: new Date('2026-01-05T15:00:00Z') }),
        ]);
        setBars({}); // NVDA bars unavailable
        setQuotes({ NVDA: 95 });
        await run(RISK_NOW);
        expect(actions()).toContain('NVDA:stop_backfill_failed');
        expect(mockClaimOnce).toHaveBeenCalledWith('mail:stop-backfill-NVDA:2026-01-05', 86_400);
    });
});

describe('A7 — in-flight orders are read before open positions', () => {
    it('reads getPendingSubmittedOrders before getOpenPositions', async () => {
        // Use the decision tick so the idle-check's own getOpenPositions call (outside the
        // try block, only made on non-decision ticks) doesn't precede the pair we're pinning.
        q.getOpenPositions.mockResolvedValue([position()]);
        setBars({ SPY: rising() });
        setQuotes({ SPY: lastOf(rising()), NVDA: 95 });
        await run(DECISION_NOW);
        const pendingOrder = q.getPendingSubmittedOrders.mock.invocationCallOrder[0]!;
        const openOrder = q.getOpenPositions.mock.invocationCallOrder[0]!;
        expect(pendingOrder).toBeLessThan(openOrder);
    });
});

describe('A5 — no new orders inside the last minute before the close', () => {
    it('stops submitting once inside 1 minute of the close, marks closeCutoffHit, decisionPhase not done', async () => {
        watch('AAA', 'BBB');
        const aaa = dipAbove(3);
        const bbb = dipAbove(4); // deeper dip → lower RSI2 → ranked first
        setBars({ SPY: rising(), AAA: aaa, BBB: bbb });
        setQuotes({ SPY: lastOf(rising()), AAA: lastOf(aaa), BBB: lastOf(bbb) });
        mockExecuteEntry.mockImplementationOnce(async () => {
            // DECISION_NOW is 15:47 ET, 13 minutes before the 16:00 close — jump to the close.
            vi.advanceTimersByTime(13 * 60_000);
            return { executed: true, exposureDelta: 5000, cashDebit: 5000 };
        });
        await run(DECISION_NOW);
        expect(mockExecuteEntry).toHaveBeenCalledTimes(1);
        expect(actions()).toContain('BBB:mr_buy');
        expect(actions()).toContain('AAA:close_cutoff');
        expect(summary()).toMatchObject({ closeCutoffHit: true });
        expect(summary().decisionPhase).toBeUndefined();
    });
});

describe('T2 — kill switch re-check on exit paths never calls executeExit', () => {
    const killSwitchFlipsAfterFirstRead = () => {
        let reads = 0;
        q.getConfigValue.mockImplementation(async (_db: unknown, key: string) =>
            key === 'trading_enabled' ? ++reads === 1 : (config[key] ?? null),
        );
    };

    it('(a) disaster stop hit in the risk phase', async () => {
        q.getOpenPositions.mockResolvedValue([position()]); // stop_price 90
        setQuotes({ NVDA: 50 });
        killSwitchFlipsAfterFirstRead();
        await run(RISK_NOW);
        expect(mockExecuteExit).not.toHaveBeenCalled();
        expect(actions()).toEqual(['NVDA:trading_disabled_mid_loop']);
    });

    it('(b) MA5 rule exit in the decision tick', async () => {
        q.getOpenPositions.mockResolvedValue([position({ stopPrice: '1' })]);
        setBars({ SPY: rising(), NVDA: rising() }); // price above SMA5 → exit signal
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(rising()) });
        killSwitchFlipsAfterFirstRead();
        await run(DECISION_NOW);
        expect(mockExecuteExit).not.toHaveBeenCalled();
        expect(actions()).toContain('NVDA:trading_disabled_mid_loop');
    });

    it('(d) auto + no price under the breaker', async () => {
        config.trading_mode = 'auto';
        q.getLatestSizing.mockResolvedValue({
            sizing: { equity: 2000, slots: 4, dailyLossLimit: 80 },
            at: new Date('2026-01-02T20:45:00Z'),
        });
        q.getTodayRealizedPnl.mockResolvedValue(-600);
        q.getOpenPositions.mockResolvedValue([position()]);
        q.getNoPriceStreak.mockResolvedValue(2);
        setQuotes({});
        killSwitchFlipsAfterFirstRead();
        await run(RISK_NOW);
        expect(mockExecuteExit).not.toHaveBeenCalled();
        expect(actions()).toEqual(['NVDA:trading_disabled_mid_loop']);
    });
});

describe('T4 — stop backfill ATR excludes the entry-day bar', () => {
    it('a wide range on the entry day does not skew the computed stop', async () => {
        const bars = series(Array(260).fill(100)); // constant ±1 range → ATR(14) = 2
        bars[bars.length - 1] = { ...bars[bars.length - 1]!, high: 1000, low: 1 }; // entry-day spike
        mockFetchDailyBars.mockImplementation(async (sym: string) =>
            sym === 'NVDA' ? bars : null,
        );
        q.getOpenPositions.mockResolvedValue([
            position({ stopPrice: null, openedAt: new Date('2026-01-05T15:00:00Z') }),
        ]);
        setQuotes({ NVDA: 95 });
        await run(RISK_NOW);
        expect(q.setPositionStopPrice).toHaveBeenCalledWith(fakeDb, 1, 80); // 100 − 10 × 2, spike excluded
    });
});

describe('T5 — a stop hit in the risk phase blocks the same-tick entry (A1)', () => {
    it('no executeEntry for a symbol stopped out earlier in the same run', async () => {
        watch('NVDA');
        q.getOpenPositions.mockResolvedValue([position()]); // stop_price 90
        setBars({ SPY: rising(), NVDA: dipAbove() });
        setQuotes({ SPY: lastOf(rising()), NVDA: 85 }); // below stop → risk phase exits it
        await run(DECISION_NOW);
        expect(mockExecuteExit).toHaveBeenCalled();
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toContain('NVDA:mr_stop_atr');
    });
});

describe('T6 — a deadline mid-run leaves decisionPhase unset', () => {
    it('a slow prefetch that crosses the run deadline sets runDeadlineHit and skips decisionPhase', async () => {
        watch('NVDA', 'MSFT');
        setBars({ SPY: rising(), NVDA: dipAbove(), MSFT: rising() });
        let calls = 0;
        mockQuote.mockImplementation(async (sym: string) => {
            calls++;
            if (calls > 1) vi.advanceTimersByTime(900_001);
            const prices: Record<string, number> = {
                SPY: lastOf(rising()),
                NVDA: lastOf(dipAbove()),
                MSFT: lastOf(rising()),
            };
            return { source: 'fmp_quote', price: prices[sym] ?? null, previousClose: null };
        });
        await run(DECISION_NOW);
        expect(summary().decisionPhase).toBeUndefined();
        expect(summary()).toMatchObject({ runDeadlineHit: true });
    });
});

describe('T7 — wiring', () => {
    it('passes dryRunCostBps 10 (default) to executeEntry', async () => {
        watch('NVDA');
        setBars({ SPY: rising(), NVDA: dipAbove() });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(dipAbove()) });
        await run(DECISION_NOW);
        expect(mockExecuteEntry.mock.calls[0]![0]).toMatchObject({ dryRunCostBps: 10 });
    });

    it('fetches daily bars with the live quote price for candidates', async () => {
        watch('NVDA');
        const nvda = dipAbove();
        setBars({ SPY: rising(), NVDA: nvda });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(nvda) });
        await run(DECISION_NOW);
        expect(mockFetchDailyBars).toHaveBeenCalledWith('NVDA', lastOf(nvda), DECISION_NOW);
    });

    it('an in-flight pending buy consumes budget for a later candidate', async () => {
        mockCash.mockResolvedValue(5000); // 총 노출 한도 = 총자산 5,000 = 미체결 매수 10 × 500
        watch('AAA');
        const aaa = dipAbove();
        setBars({ SPY: rising(), AAA: aaa });
        setQuotes({ SPY: lastOf(rising()), AAA: lastOf(aaa), ZZZ: 500 });
        q.getPendingSubmittedOrders.mockResolvedValue([
            { symbol: 'ZZZ', side: 'buy', status: 'submitted', quantity: 10 },
        ]);
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toEqual(['AAA:mr_skip_budget']);
    });

    it('in-flight order count reaching the daily trade limit blocks entries', async () => {
        watch('NVDA');
        setBars({ SPY: rising(), NVDA: dipAbove() });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(dipAbove()) });
        q.getTodayInflightOrderCount.mockResolvedValue(20);
        await run(DECISION_NOW);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
        expect(actions()).toContain('NVDA:mr_skip_breaker');
        expect(summary()).toMatchObject({ entriesBlockedBy: 'daily_trade_limit' });
    });
});

describe('T8 — a held position with no live price is a data error, not an exit', () => {
    it('records mr_data_error and never calls executeExit', async () => {
        q.getOpenPositions.mockResolvedValue([position({ stopPrice: '1' })]);
        setBars({ SPY: rising(), NVDA: rising() });
        setQuotes({ SPY: lastOf(rising()) }); // no NVDA quote
        await run(DECISION_NOW);
        expect(actions()).toEqual(['NVDA:skipped_no_price', 'NVDA:mr_data_error']);
        expect(decisionsOf()[1]!.detail).toMatchObject({ reason: 'no_live_price' });
        expect(mockExecuteExit).not.toHaveBeenCalled();
    });
});

describe('A10 — every entry-signal decision carries detail.mr.signal', () => {
    it('is set on mr_skip_budget, not only on mr_buy', async () => {
        mockCash.mockResolvedValue(1); // forces budget skip
        watch('NVDA');
        setBars({ SPY: rising(), NVDA: dipAbove() });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(dipAbove()) });
        await run(DECISION_NOW);
        expect(actions()).toEqual(['NVDA:mr_skip_budget']);
        expect((decisionsOf()[0]!.detail as { mr: { signal: boolean } }).mr.signal).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 소프트 국면 캡 — SPY ≤ SMA50이면 동시 보유를 N개로 묶는다(신규 진입만, 옵션·기본 OFF)
// ---------------------------------------------------------------------------

describe('soft regime cap — SPY at/below SMA50 limits open positions (entries only)', () => {
    /** SPY: 200일선 위지만 최근 급락으로 종가 < SMA50. */
    const spyBelow50 = () => dipAbove(3);
    const NAMES = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'] as const;

    /** 깊이가 서로 다른 눌림 N종목 — 이름 순서대로 얕다(AAA) → 깊다(마지막), 즉 RSI(2)는 뒤쪽이 낮다. */
    function setupSignals(spy: number[] | null, n: number) {
        const names = NAMES.slice(0, n);
        watch(...names);
        const map: BarsMap = { SPY: spy };
        const quotes: Record<string, number | null> = { SPY: spy ? lastOf(spy) : null };
        names.forEach((name, i) => {
            const c = dipAbove(1.5 + i * 0.5);
            map[name] = c;
            quotes[name] = lastOf(c);
        });
        setBars(map);
        setQuotes(quotes);
        return names;
    }
    const enable = (max?: number) => {
        config.mr_soft_regime_enabled = true;
        if (max !== undefined) config.mr_soft_regime_max_positions = max;
    };
    const boughtSymbols = () =>
        mockExecuteEntry.mock.calls.map((c) => (c[1] as { symbol: string }).symbol);
    const softOf = (d: Record<string, unknown>) =>
        (d.detail as { mr: { softRegime?: Record<string, unknown>; reason?: string } }).mr;

    beforeEach(() => {
        mockExecuteEntry.mockResolvedValue({
            executed: true,
            exposureDelta: 1000,
            cashDebit: 1000,
        });
    });

    it('is OFF by default: six signals under SPY < SMA50 all go through, no softRegime record', async () => {
        setupSignals(spyBelow50(), 6);
        await run(DECISION_NOW);
        expect(mockExecuteEntry).toHaveBeenCalledTimes(6);
        expect(actions().filter((a) => a.endsWith('mr_skip_soft_regime'))).toEqual([]);
        expect(summary()).not.toHaveProperty('softRegime');
        expect(softOf(decisionsOf()[0]!).softRegime).toBeUndefined();
    });

    it('enabled but SPY above SMA50: no cap', async () => {
        enable(2);
        setupSignals(rising(), 6);
        await run(DECISION_NOW);
        expect(mockExecuteEntry).toHaveBeenCalledTimes(6);
        expect(summary().softRegime).toMatchObject({ active: false, signalsCut: 0, room: null });
    });

    it('enabled, SPY below SMA50, cap 4, flat book: buys the 4 lowest-RSI signals, cuts the rest with a distinct reason', async () => {
        enable(4);
        setupSignals(spyBelow50(), 6);
        await run(DECISION_NOW);
        // 깊은 눌림(RSI 낮음)부터: FFF, EEE, DDD, CCC
        expect(boughtSymbols()).toEqual(['FFF', 'EEE', 'DDD', 'CCC']);
        const cut = decisionsOf().filter((d) => d.action === 'mr_skip_soft_regime');
        expect(cut.map((d) => d.symbol)).toEqual(['BBB', 'AAA']);
        const mr = softOf(cut[0]!);
        expect(mr.reason).toBe('soft_regime_cap');
        expect(mr.softRegime).toMatchObject({
            active: true,
            cap: 4,
            openPositions: 0,
            room: 4,
        });
        expect(mr.softRegime!.spyPrice as number).toBeLessThanOrEqual(
            mr.softRegime!.spySma50 as number,
        );
        // 컷 행도 신호 행이다 — 리뷰 크론이 그대로 찾는다.
        expect((cut[0]!.detail as { mr: { signal: boolean } }).mr.signal).toBe(true);
        expect(summary().softRegime).toMatchObject({
            active: true,
            cap: 4,
            openPositions: 0,
            signalsCut: 2,
        });
        // 판단 자체는 정상 종료 — 컷은 데이터 오류가 아니다(재시도 안 함).
        expect(summary()).toMatchObject({ decisionPhase: 'done' });
    });

    it('records the SPY SMA50 on bought rows too (detail.mr)', async () => {
        enable(4);
        setupSignals(spyBelow50(), 1);
        await run(DECISION_NOW);
        const mr = softOf(decisionsOf()[0]!) as unknown as Record<string, unknown>;
        expect(typeof mr.spySma50).toBe('number');
        expect((mr.softRegime as Record<string, unknown>).room).toBe(4);
    });

    describe('with positions already open', () => {
        const heldDip = (symbol: string) => {
            const c = dipAbove(3);
            return { symbol, bars: c, price: lastOf(c) };
        };
        function hold(symbols: string[], opts: { exit?: boolean } = {}) {
            const map: BarsMap = {};
            const quotes: Record<string, number | null> = {};
            for (const sym of symbols) {
                // exit: 상승 계열이라 MA5 회복 → 오늘 규칙 청산. 아니면 눌림이라 보유 유지.
                const c = opts.exit ? rising() : heldDip(sym).bars;
                map[sym] = c;
                quotes[sym] = lastOf(c);
            }
            q.getOpenPositions.mockResolvedValue(
                symbols.map((s, i) => position({ id: 10 + i, symbol: s })),
            );
            return { map, quotes };
        }
        function withHeld(held: string[], newcomers: number, opts: { exit?: boolean } = {}) {
            const spy = spyBelow50();
            const { map, quotes } = hold(held, opts);
            const names = NAMES.slice(0, newcomers);
            watch(...held, ...names);
            map.SPY = spy;
            quotes.SPY = lastOf(spy);
            names.forEach((name, i) => {
                const c = dipAbove(1.5 + i * 0.5);
                map[name] = c;
                quotes[name] = lastOf(c);
            });
            setBars(map);
            setQuotes(quotes);
        }

        it('partial room: 3 held + cap 4 → exactly 1 new entry (lowest RSI), the rest cut', async () => {
            enable(4);
            withHeld(['H1', 'H2', 'H3'], 3);
            await run(DECISION_NOW);
            expect(boughtSymbols()).toEqual(['CCC']);
            expect(decisionsOf().filter((d) => d.action === 'mr_skip_soft_regime')).toHaveLength(2);
            expect(summary().softRegime).toMatchObject({
                openPositions: 3,
                room: 1,
                signalsCut: 2,
            });
            expect(mockExecuteExit).not.toHaveBeenCalled();
        });

        it('at the cap (4 held) → no new entry; existing positions are never touched', async () => {
            enable(4);
            withHeld(['H1', 'H2', 'H3', 'H4'], 2);
            await run(DECISION_NOW);
            expect(mockExecuteEntry).not.toHaveBeenCalled();
            expect(mockExecuteExit).not.toHaveBeenCalled();
            expect(
                decisionsOf()
                    .filter((d) => d.action === 'mr_skip_soft_regime')
                    .map((d) => d.symbol),
            ).toEqual(['BBB', 'AAA']);
            expect(summary().softRegime).toMatchObject({ room: 0, signalsCut: 2 });
        });

        it('over the cap (6 held, cap 4) → still no new entry and never a forced exit', async () => {
            enable(4);
            withHeld(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'], 1);
            await run(DECISION_NOW);
            expect(mockExecuteEntry).not.toHaveBeenCalled();
            expect(mockExecuteExit).not.toHaveBeenCalled();
            expect(summary().softRegime).toMatchObject({ openPositions: 6, room: 0 });
        });

        it('counts the book after today’s rule exits: exits still run and free their slots', async () => {
            enable(4);
            withHeld(['H1', 'H2', 'H3', 'H4'], 2, { exit: true });
            await run(DECISION_NOW);
            expect(mockExecuteExit).toHaveBeenCalledTimes(4);
            expect(summary().softRegime).toMatchObject({ openPositions: 0, room: 4 });
            expect(boughtSymbols()).toEqual(['BBB', 'AAA']);
        });

        it('a rejected sell does not free its slot (the position is still held)', async () => {
            enable(4);
            withHeld(['H1', 'H2', 'H3', 'H4'], 2, { exit: true });
            mockExecuteExit
                .mockResolvedValueOnce({
                    executed: false,
                    action: 'order_rejected',
                    exposureDelta: 0,
                    cashDebit: 0,
                })
                .mockResolvedValue({ executed: true, exposureDelta: -1000, cashDebit: 0 });
            await run(DECISION_NOW);
            expect(summary().softRegime).toMatchObject({ openPositions: 1, room: 3 });
        });

        it('a needs_review sell and a semi_auto queued sell (no action, not executed) keep their slots', async () => {
            enable(4);
            withHeld(['H1', 'H2', 'H3', 'H4'], 2, { exit: true });
            mockExecuteExit
                .mockResolvedValueOnce({
                    executed: false,
                    action: 'needs_review',
                    exposureDelta: 0,
                    cashDebit: 0,
                })
                .mockResolvedValueOnce({ executed: false, exposureDelta: 0, cashDebit: 0 })
                .mockResolvedValue({ executed: true, exposureDelta: -1000, cashDebit: 0 });
            await run(DECISION_NOW);
            expect(summary().softRegime).toMatchObject({ openPositions: 2, room: 2 });
        });

        it('an accepted (submitted / partial) sell frees its slot', async () => {
            enable(4);
            withHeld(['H1', 'H2'], 2, { exit: true });
            mockExecuteExit
                .mockResolvedValueOnce({
                    executed: false,
                    action: 'order_submitted',
                    exposureDelta: -1000,
                    cashDebit: 0,
                })
                .mockResolvedValueOnce({
                    executed: false,
                    action: 'order_partial',
                    exposureDelta: -1000,
                    cashDebit: 0,
                });
            await run(DECISION_NOW);
            expect(summary().softRegime).toMatchObject({ openPositions: 0, room: 4 });
        });

        it('a disaster-stop sell from the risk phase frees its slot only when it went out', async () => {
            enable(4);
            // H1: stop hit (price below stop) in the risk phase, sell executes → freed.
            // H2: stop hit, sell rejected → still occupies.
            const spy = spyBelow50();
            const held = (id: number, symbol: string) =>
                position({
                    id,
                    symbol,
                    stopPrice: '1000',
                    openedAt: new Date('2026-01-02T20:47:00Z'),
                });
            q.getOpenPositions.mockResolvedValue([held(1, 'H1'), held(2, 'H2')]);
            watch('H1', 'H2');
            const c = dipAbove(3);
            setBars({ SPY: spy, H1: c, H2: c });
            setQuotes({ SPY: lastOf(spy), H1: lastOf(c), H2: lastOf(c) });
            mockExecuteExit
                .mockResolvedValueOnce({ executed: true, exposureDelta: -1000, cashDebit: 0 })
                .mockResolvedValueOnce({
                    executed: false,
                    action: 'order_rejected',
                    exposureDelta: 0,
                    cashDebit: 0,
                });
            await run(DECISION_NOW);
            expect(summary().softRegime).toMatchObject({ openPositions: 1 });
        });

        it('needs_review symbols (possibly live at the broker) occupy a slot, deduplicated against held and in-flight', async () => {
            enable(4);
            withHeld(['H1'], 2);
            // ZZZ: only needs_review; H1: held AND needs_review (counted once); YYY: in-flight AND needs_review.
            q.getNeedsReviewSymbols.mockResolvedValue(['ZZZ', 'H1', 'YYY']);
            q.getPendingSubmittedOrders.mockResolvedValue([
                { symbol: 'YYY', side: 'buy', status: 'submitted', quantity: 1 },
            ]);
            await run(DECISION_NOW);
            expect(summary().softRegime).toMatchObject({ openPositions: 3, room: 1 });
        });

        it('in-flight buys (auto unfilled / semi_auto approvals) occupy a slot', async () => {
            enable(4);
            withHeld(['H1', 'H2'], 3);
            q.getPendingSubmittedOrders.mockResolvedValue([
                { symbol: 'ZZZ', side: 'buy', status: 'submitted', quantity: 1 },
            ]);
            q.getPendingOrders.mockResolvedValue([
                { symbol: 'YYY', side: 'buy', status: 'pending', quantity: 1, priceLimit: '10' },
                // 매도 대기·이미 처리된 승인은 칸이 아니다.
                { symbol: 'XXX', side: 'sell', status: 'pending', quantity: 1, priceLimit: '10' },
                { symbol: 'WWW', side: 'buy', status: 'approved', quantity: 1, priceLimit: '10' },
            ]);
            setQuotes({ SPY: lastOf(spyBelow50()), ZZZ: 10, YYY: 10 });
            // 위에서 덮어쓴 시세를 다시 채운다.
            const prices: Record<string, number | null> = {
                SPY: lastOf(spyBelow50()),
                ZZZ: 10,
                YYY: 10,
            };
            for (const n of ['H1', 'H2']) prices[n] = lastOf(dipAbove(3));
            for (const [i, n] of (['AAA', 'BBB', 'CCC'] as const).entries()) {
                prices[n] = lastOf(dipAbove(1.5 + i * 0.5));
            }
            setQuotes(prices);
            await run(DECISION_NOW);
            // 보유 2 + 접수 1 + 승인 대기 1 = 4 → 여유 0
            expect(summary().softRegime).toMatchObject({ openPositions: 4, room: 0 });
            expect(mockExecuteEntry).not.toHaveBeenCalled();
        });

        it('an in-flight buy on a symbol that is already held is not double counted', async () => {
            enable(4);
            withHeld(['H1'], 2);
            q.getPendingSubmittedOrders.mockResolvedValue([
                { symbol: 'H1', side: 'buy', status: 'submitted', quantity: 1 },
            ]);
            await run(DECISION_NOW);
            expect(summary().softRegime).toMatchObject({ openPositions: 1, room: 3 });
        });
    });

    it('a rejected / unaffordable order does not use a slot: the next signal still gets it', async () => {
        enable(1);
        setupSignals(spyBelow50(), 2);
        mockExecuteEntry
            .mockResolvedValueOnce({
                executed: false,
                action: 'skipped_insufficient_cash',
                exposureDelta: 0,
                cashDebit: 0,
            })
            .mockResolvedValueOnce({ executed: true, exposureDelta: 1000, cashDebit: 1000 });
        await run(DECISION_NOW);
        expect(boughtSymbols()).toEqual(['BBB', 'AAA']);
        expect(actions().filter((a) => a.endsWith('mr_skip_soft_regime'))).toEqual([]);
    });

    it('a pending semi_auto approval (executed=false, exposure reserved) uses the slot', async () => {
        enable(1);
        setupSignals(spyBelow50(), 2);
        mockExecuteEntry.mockResolvedValue({
            executed: false,
            exposureDelta: 1000,
            cashDebit: 1000,
        });
        await run(DECISION_NOW);
        expect(boughtSymbols()).toEqual(['BBB']);
        expect(actions()).toContain('AAA:mr_skip_soft_regime');
    });

    it('the cap takes precedence over an unknown equity: no equity_unavailable retry for a cut signal', async () => {
        enable(1);
        q.getOpenPositions.mockResolvedValue([position({ symbol: 'H1' })]);
        const spy = spyBelow50();
        watch('H1', 'AAA');
        setBars({ SPY: spy, H1: dipAbove(3), AAA: dipAbove(2) });
        setQuotes({ SPY: lastOf(spy), H1: lastOf(dipAbove(3)), AAA: lastOf(dipAbove(2)) });
        mockCash.mockResolvedValue(null);
        await run(DECISION_NOW);
        expect(actions()).toContain('AAA:mr_skip_soft_regime');
        expect(actions()).not.toContain('AAA:mr_data_error');
    });

    it('SPY SMA50 tie counts as active (at-or-below): flat SPY, hard filter off', async () => {
        enable(1);
        config.mr_regime_filter = false;
        const flat = Array.from({ length: 260 }, () => 100);
        setupSignals(flat, 2);
        await run(DECISION_NOW);
        expect(boughtSymbols()).toEqual(['BBB']);
        expect(summary().softRegime).toMatchObject({ active: true, signalsCut: 1 });
    });

    it('works without the hard filter: cap applies even when SPY is under its SMA200', async () => {
        enable(2);
        config.mr_regime_filter = false;
        // 하락 추세 SPY + 종목은 자체 200일선 위 눌림.
        setupSignals(falling(), 3);
        await run(DECISION_NOW);
        expect(boughtSymbols()).toEqual(['CCC', 'BBB']);
        expect(actions()).toContain('AAA:mr_skip_soft_regime');
    });

    it('with the hard filter on, SPY < SMA200 still wins: one mr_regime_off row, no soft cut rows', async () => {
        enable(2);
        setupSignals(falling(), 3);
        await run(DECISION_NOW);
        expect(actions()).toEqual(['-:mr_regime_off']);
    });

    describe('SPY data missing', () => {
        it('hard filter on (+ cap on) → fail closed exactly as before: one mr_data_error, no entries, not done', async () => {
            enable(4);
            watch('AAA');
            setBars({ SPY: null, AAA: dipAbove(2) });
            setQuotes({ AAA: lastOf(dipAbove(2)) });
            await run(DECISION_NOW);
            expect(mockExecuteEntry).not.toHaveBeenCalled();
            expect(actions()).toEqual(['SPY:mr_data_error']);
            expect(summary()).not.toHaveProperty('decisionPhase');
        });

        it('cap only, SPY bars unreadable → cap assumed active, entries proceed inside the room, day marked done', async () => {
            enable(4);
            config.mr_regime_filter = false;
            watch('AAA');
            setBars({ SPY: null, AAA: dipAbove(2) });
            setQuotes({ AAA: lastOf(dipAbove(2)) });
            await run(DECISION_NOW);
            expect(boughtSymbols()).toEqual(['AAA']);
            const err = decisionsOf().find((d) => d.action === 'mr_data_error')!;
            expect(err.detail).toMatchObject({ regime: 'unavailable', assumedCap: true });
            const buy = decisionsOf().find((d) => d.symbol === 'AAA')!;
            expect(softOf(buy).softRegime).toMatchObject({
                active: true,
                assumed: true,
                regime: 'unavailable',
                reason: 'spy_unavailable_assume_active',
                room: 4,
            });
            expect(summary().softRegime).toMatchObject({ active: true, assumed: true });
            // 진입이 나갔으므로 재시도하지 않는다(재시도하면 같은 날 두 번째 판단이 또 산다).
            expect(summary()).toMatchObject({ decisionPhase: 'done' });
        });

        it('cap only, SPY has bars but no live price → same assumed-active path, not yesterday’s close', async () => {
            enable(4);
            config.mr_regime_filter = false;
            watch('AAA');
            setBars({ SPY: rising(), AAA: dipAbove(2) });
            setQuotes({ AAA: lastOf(dipAbove(2)) });
            await run(DECISION_NOW);
            expect(boughtSymbols()).toEqual(['AAA']);
            expect(summary().softRegime).toMatchObject({ assumed: true, active: true });
        });

        it('cap only, SPY missing: the assumed cap still limits to cap − open', async () => {
            enable(4);
            config.mr_regime_filter = false;
            setupSignals(null, 6);
            await run(DECISION_NOW);
            expect(mockExecuteEntry).toHaveBeenCalledTimes(4);
            expect(summary().softRegime).toMatchObject({ assumed: true, signalsCut: 2 });
        });

        it('cap only, SPY missing, no entry made → data error kept, day NOT marked done (next tick retries with real SPY)', async () => {
            enable(4);
            config.mr_regime_filter = false;
            watch('MSFT');
            setBars({ SPY: null, MSFT: rising() });
            setQuotes({ MSFT: lastOf(rising()) });
            await run(DECISION_NOW);
            expect(mockExecuteEntry).not.toHaveBeenCalled();
            expect(actions()).toContain('SPY:mr_data_error');
            expect(summary()).not.toHaveProperty('decisionPhase');
        });

        it('both off → SPY is not needed: entries proceed without SPY data', async () => {
            config.mr_regime_filter = false;
            watch('AAA');
            setBars({ SPY: null, AAA: dipAbove(2) });
            setQuotes({ AAA: lastOf(dipAbove(2)) });
            await run(DECISION_NOW);
            expect(boughtSymbols()).toEqual(['AAA']);
        });
    });

    describe('the day’s first real cap reading is reused on retried decision ticks', () => {
        it('asks for the first real reading since the ET day start', async () => {
            enable(4);
            setupSignals(spyBelow50(), 1);
            await run(DECISION_NOW);
            expect(q.getFirstSoftRegimeActiveSince).toHaveBeenCalledWith(
                fakeDb,
                etDayStart(DECISION_NOW),
            );
        });

        it('does not ask when the cap is off', async () => {
            setupSignals(spyBelow50(), 1);
            await run(DECISION_NOW);
            expect(q.getFirstSoftRegimeActiveSince).not.toHaveBeenCalled();
        });

        it('earlier reading active=true keeps the cap on even if SPY is now above SMA50', async () => {
            enable(2);
            q.getFirstSoftRegimeActiveSince.mockResolvedValue(true);
            setupSignals(rising(), 4);
            await run(DECISION_NOW);
            expect(mockExecuteEntry).toHaveBeenCalledTimes(2);
            expect(summary().softRegime).toMatchObject({ active: true, locked: true });
        });

        it('earlier reading active=false keeps the cap off even if SPY is now below SMA50', async () => {
            enable(2);
            q.getFirstSoftRegimeActiveSince.mockResolvedValue(false);
            setupSignals(spyBelow50(), 4);
            await run(DECISION_NOW);
            expect(mockExecuteEntry).toHaveBeenCalledTimes(4);
            expect(summary().softRegime).toMatchObject({ active: false, locked: true });
        });

        it('SPY unavailable but an earlier real reading exists → uses it, no data-error row', async () => {
            enable(2);
            config.mr_regime_filter = false;
            q.getFirstSoftRegimeActiveSince.mockResolvedValue(true);
            setupSignals(null, 4);
            await run(DECISION_NOW);
            expect(mockExecuteEntry).toHaveBeenCalledTimes(2);
            expect(actions().filter((a) => a.endsWith('mr_data_error'))).toEqual([]);
            expect(summary().softRegime).toMatchObject({ locked: true, assumed: false });
        });

        it('a failing lookup falls back to the live reading', async () => {
            enable(2);
            q.getFirstSoftRegimeActiveSince.mockRejectedValue(new Error('db'));
            setupSignals(spyBelow50(), 4);
            await run(DECISION_NOW);
            expect(mockExecuteEntry).toHaveBeenCalledTimes(2);
            expect(summary().softRegime).toMatchObject({ active: true, locked: false });
        });
    });

    describe('slot accounting under failures', () => {
        it('executeEntry throwing after the call started still uses the slot (the order may be live)', async () => {
            enable(1);
            setupSignals(spyBelow50(), 2);
            mockExecuteEntry.mockRejectedValueOnce(new Error('timeout after send'));
            await run(DECISION_NOW);
            // BBB (lowest RSI) throws; AAA must be cut, not bought.
            expect(boughtSymbols()).toEqual(['BBB']);
            expect(actions()).toEqual(['BBB:error', 'AAA:mr_skip_soft_regime']);
        });

        it('a throw before executeEntry was reached (no order possible) does not use the slot', async () => {
            enable(1);
            config.trading_mode = 'semi_auto';
            setupSignals(spyBelow50(), 2);
            q.getPendingOrders
                .mockResolvedValueOnce([]) // 시작 시 승인 대기 조회
                .mockRejectedValueOnce(new Error('db blip')) // BBB의 pending_exists 확인
                .mockResolvedValue([]);
            await run(DECISION_NOW);
            expect(actions()).toContain('BBB:error');
            expect(boughtSymbols()).toEqual(['AAA']);
        });
    });

    it('a corrupt cap row falls back to 4 (runtime defense), never to "no entries"', async () => {
        config.mr_soft_regime_enabled = true;
        config.mr_soft_regime_max_positions = 99;
        setupSignals(spyBelow50(), 6);
        await run(DECISION_NOW);
        expect(mockExecuteEntry).toHaveBeenCalledTimes(4);
    });

    it('risk-only ticks (no decision phase) are unaffected: disaster stop still sells with the cap on', async () => {
        enable(1);
        const c = dipAbove(3);
        q.getOpenPositions.mockResolvedValue([position({ symbol: 'H1', stopPrice: '1000' })]);
        setQuotes({ H1: lastOf(c) });
        await run(RISK_NOW);
        expect(mockExecuteExit).toHaveBeenCalledTimes(1);
        expect(mockExecuteEntry).not.toHaveBeenCalled();
    });
});
