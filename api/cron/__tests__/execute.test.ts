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
    getSymbolsSoldSince: vi.fn(),
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
vi.mock('../../../lib/notification/quiet-hours', () => ({ isQuietHours: () => false }));

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
        max_position_size: 5000,
        max_total_exposure: 25000,
        max_trades_per_day: 20,
        max_daily_loss_usd: 500,
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
    q.getSymbolsSoldSince.mockResolvedValue(new Set());
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
        expect(q.setPositionStopPrice).toHaveBeenCalledWith(fakeDb, 1, 90); // 100 − 5 × 2
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
            quantity: Math.floor(5000 / lastOf(nvda)),
            price: lastOf(nvda),
        });
        // 손절 = 진입가 − 5 × ATR(14, 오늘 봉 제외)
        const atrPrev = wilderAtr(series(nvda).slice(0, -1), 14)!;
        expect((args as { stopPrice: number }).stopPrice).toBeCloseTo(
            lastOf(nvda) - 5 * atrPrev,
            6,
        );
        expect(actions()).toEqual(['NVDA:mr_buy']);
        const d = decisionsOf()[0]!;
        expect((d.detail as { mr: { rank: number } }).mr.rank).toBe(1);
        expect(summary()).toMatchObject({ decisionTick: true, decisionPhase: 'done' });
    });

    it('ranks signals by RSI(2) and skips what the budget cannot fund', async () => {
        config.max_total_exposure = 5000; // one slot
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

    it('bars missing: data error normally, forced exit while the loss breaker is up', async () => {
        q.getOpenPositions.mockResolvedValue([position({ stopPrice: '1' })]);
        setBars({ SPY: rising(), NVDA: null });
        setQuotes({ SPY: lastOf(rising()), NVDA: 95 });
        await run(DECISION_NOW);
        expect(actions()).toEqual(['NVDA:mr_data_error']);

        q.getTodayRealizedPnl.mockResolvedValue(-600);
        await run(DECISION_NOW);
        expect(actions()).toEqual(['NVDA:mr_forced_exit']);
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

    it('live modes ask the broker for unscheduled closures', async () => {
        config.trading_mode = 'auto';
        mockIsUsMarketOpen.mockResolvedValue(false);
        q.getOpenPositions.mockResolvedValue([position()]);
        expect(await run(RISK_NOW)).toEqual({ skipped: true, reason: 'us-market-holiday' });
    });

    it('records cash and exposure consumption across entries in one run', async () => {
        config.max_total_exposure = 1_000_000;
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

    it('broker calendar failure in a live mode skips with a mail', async () => {
        config.trading_mode = 'semi_auto';
        q.getOpenPositions.mockResolvedValue([position()]);
        mockIsUsMarketOpen.mockRejectedValue(new Error('toss down'));
        expect(await run(RISK_NOW)).toMatchObject({
            skipped: true,
            reason: 'market_status_unavailable',
        });
        expect(mockSendError).toHaveBeenCalled();
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

    it('auto under the loss breaker liquidates a priceless position at market', async () => {
        config.trading_mode = 'auto';
        q.getTodayRealizedPnl.mockResolvedValue(-600);
        q.getOpenPositions.mockResolvedValue([position()]);
        setQuotes({});
        await run(RISK_NOW);
        expect(actions()).toEqual(['NVDA:mr_forced_exit']);
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
        config.max_total_exposure = 1_000_000;
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

    it('(c) forced exit when daily bars fail under the loss breaker', async () => {
        q.getTodayRealizedPnl.mockResolvedValue(-600);
        q.getOpenPositions.mockResolvedValue([position({ stopPrice: '1' })]);
        setBars({ SPY: rising(), NVDA: null });
        setQuotes({ SPY: lastOf(rising()), NVDA: 95 });
        killSwitchFlipsAfterFirstRead();
        await run(DECISION_NOW);
        expect(mockExecuteExit).not.toHaveBeenCalled();
        expect(actions()).toContain('NVDA:trading_disabled_mid_loop');
    });

    it('(d) auto + no price under the breaker', async () => {
        config.trading_mode = 'auto';
        q.getTodayRealizedPnl.mockResolvedValue(-600);
        q.getOpenPositions.mockResolvedValue([position()]);
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
        expect(q.setPositionStopPrice).toHaveBeenCalledWith(fakeDb, 1, 90); // 100 − 5 × 2, spike excluded
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
        config.max_total_exposure = 5000;
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
        config.max_total_exposure = 1; // forces budget skip
        watch('NVDA');
        setBars({ SPY: rising(), NVDA: dipAbove() });
        setQuotes({ SPY: lastOf(rising()), NVDA: lastOf(dipAbove()) });
        await run(DECISION_NOW);
        expect(actions()).toEqual(['NVDA:mr_skip_budget']);
        expect((decisionsOf()[0]!.detail as { mr: { signal: boolean } }).mr.signal).toBe(true);
    });
});
