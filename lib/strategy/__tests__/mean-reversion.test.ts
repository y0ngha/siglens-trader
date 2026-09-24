import { describe, it, expect } from 'vitest';
import fixture from './fixtures/mr-parity.json';
import {
    sma,
    wilderRsi,
    wilderAtr,
    readSymbol,
    readRegime,
    isEntrySignal,
    rankSignals,
    stopPriceFor,
    holdDays,
    evaluateRuleExit,
    isStopHit,
    DEFAULT_MR_PARAMS,
    type DailyBar,
    type SymbolReading,
} from '../mean-reversion';

/** 합성 봉. 범위는 일정(±1)하게 둬서 ATR 기대값을 손으로 셀 수 있게 한다. */
const bars = (closes: number[], start = '2025-01-01'): DailyBar[] =>
    closes.map((c, i) => ({
        date: new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10),
        open: c,
        high: c + 1,
        low: c - 1,
        close: c,
    }));

const UP = { up: true, price: 2, sma200: 1 };

describe('indicators', () => {
    it('sma is the mean of the last n values, null when too short or n <= 0', () => {
        expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
        expect(sma([1], 2)).toBeNull();
        expect(sma([1, 2], 0)).toBeNull();
    });

    it('wilderRsi is 100 on a monotonic rise and null when too short', () => {
        expect(wilderRsi([1, 2, 3, 4, 5], 2)).toBe(100);
        expect(wilderRsi([1, 2], 2)).toBeNull();
    });

    it('wilderRsi is below 50 on a fall', () => {
        expect(wilderRsi([5, 4, 3, 2, 1], 2)!).toBeLessThan(50);
    });

    it('wilderAtr of constant-range bars equals that range; null when too short', () => {
        expect(wilderAtr(bars(Array(20).fill(10)), 14)).toBeCloseTo(2, 10);
        expect(wilderAtr(bars([10]), 14)).toBeNull();
    });

    it('matches the backtest reference on real FMP bars (last RSI2 / ATR14)', () => {
        for (const s of ['NVDA', 'TSLA'] as const) {
            const f = fixture.symbols[s];
            expect(
                wilderRsi(
                    f.bars.map((b) => b.close),
                    2,
                ),
            ).toBeCloseTo(f.lastRsi2, 4);
            expect(wilderAtr(f.bars, 14)).toBeCloseTo(f.lastAtr14, 4);
        }
    });
});

describe('parity with the backtest (spec §9)', () => {
    // 백테스트 스크립트가 같은 잘린 계열에서 낸 신호 날짜와 **정확히** 같아야 한다. 이게 깨지면
    // 코드가 백테스트가 검증한 규칙이 아니게 된 것이다.
    it('signals on exactly the dates the backtest did', () => {
        const spy = fixture.spy as DailyBar[];
        for (const s of ['NVDA', 'TSLA'] as const) {
            const f = fixture.symbols[s];
            const got: string[] = [];
            for (let i = 0; i < f.bars.length; i++) {
                const upto = f.bars.slice(0, i + 1) as DailyBar[];
                const day = upto[i]!.date;
                const reading = readSymbol(upto);
                const regime = readRegime(spy.filter((b) => b.date <= day));
                if (reading && isEntrySignal(reading, regime, DEFAULT_MR_PARAMS)) got.push(day);
            }
            expect(got.length).toBeGreaterThan(0);
            expect(got).toEqual(f.expectedSignals);
        }
    });
});

describe('readSymbol / readRegime', () => {
    it('is null below 200 bars (recent listing = no signal)', () => {
        expect(readSymbol(bars(Array(199).fill(10)))).toBeNull();
        expect(readRegime(bars(Array(199).fill(10)))).toBeNull();
    });

    it('rejects a non-positive last close', () => {
        const b = bars(Array(210).fill(10));
        b[b.length - 1] = { ...b[b.length - 1]!, close: 0 };
        expect(readSymbol(b)).toBeNull();
        expect(readRegime(b)).toBeNull();
    });

    it('reads the last bar as today and computes the moving averages', () => {
        const closes = [...Array(205).fill(100), 90];
        const r = readSymbol(bars(closes))!;
        expect(r.price).toBe(90);
        expect(r.sma5).toBeCloseTo((100 * 4 + 90) / 5, 10);
        expect(r.sma200).toBeCloseTo((100 * 199 + 90) / 200, 10);
        expect(r.date).toBe(bars(closes).at(-1)!.date);
    });

    it("atrPrev excludes today's (still forming) bar", () => {
        const b = bars(Array(210).fill(10));
        b[b.length - 1] = { ...b[b.length - 1]!, high: 100, low: 1 };
        expect(readSymbol(b)!.atrPrev).toBeCloseTo(2, 10);
    });

    it('regime is up only when SPY is above its SMA200', () => {
        expect(readRegime(bars([...Array(200).fill(100), 101]))!.up).toBe(true);
        expect(readRegime(bars([...Array(200).fill(100), 99]))!.up).toBe(false);
    });
});

describe('isEntrySignal', () => {
    const base: SymbolReading = {
        date: '2026-01-02',
        price: 110,
        sma200: 100,
        sma5: 115,
        rsi2: 5,
        atrPrev: 2,
    };

    it('buys above SMA200 with RSI2 below the threshold in an up regime', () => {
        expect(isEntrySignal(base, UP, DEFAULT_MR_PARAMS)).toBe(true);
    });

    it('does not buy at/below SMA200 or with RSI2 at/above the threshold', () => {
        expect(isEntrySignal({ ...base, price: 100 }, UP, DEFAULT_MR_PARAMS)).toBe(false);
        expect(isEntrySignal({ ...base, rsi2: 10 }, UP, DEFAULT_MR_PARAMS)).toBe(false);
    });

    it('regime filter: down or unknown blocks; with the filter off the regime is ignored', () => {
        expect(isEntrySignal(base, { ...UP, up: false }, DEFAULT_MR_PARAMS)).toBe(false);
        expect(isEntrySignal(base, null, DEFAULT_MR_PARAMS)).toBe(false);
        expect(isEntrySignal(base, null, { ...DEFAULT_MR_PARAMS, regimeFilter: false })).toBe(true);
    });
});

describe('rankSignals', () => {
    it('orders by RSI2 ascending without mutating the input', () => {
        const xs = [
            { rsi2: 5, s: 'a' },
            { rsi2: 1, s: 'b' },
            { rsi2: 3, s: 'c' },
        ];
        expect(rankSignals(xs).map((x) => x.s)).toEqual(['b', 'c', 'a']);
        expect(xs[0]!.s).toBe('a');
    });
});

describe('stopPriceFor / isStopHit', () => {
    it('is entry − k×ATR; null when k = 0, ATR missing/non-finite, or the stop is not positive', () => {
        expect(stopPriceFor(100, 2, 5)).toBe(90);
        expect(stopPriceFor(100, 2, 0)).toBeNull();
        expect(stopPriceFor(100, null, 5)).toBeNull();
        expect(stopPriceFor(100, Number.NaN, 5)).toBeNull();
        expect(stopPriceFor(10, 3, 5)).toBeNull();
    });

    it('hits at or below the stop and never with no stop', () => {
        expect(isStopHit(90, 90)).toBe(true);
        expect(isStopHit(89, 90)).toBe(true);
        expect(isStopHit(90.01, 90)).toBe(false);
        expect(isStopHit(1, null)).toBe(false);
    });
});

describe('holdDays', () => {
    it('counts distinct dates after the entry date, today exactly once', () => {
        const b = bars([1, 2, 3, 4], '2026-01-01'); // 01..04
        expect(holdDays(b, '2026-01-01')).toBe(3);
        expect(holdDays([...b, { ...b[3]! }], '2026-01-01')).toBe(3);
        expect(holdDays(b, '2026-01-04')).toBe(0);
    });
});

describe('evaluateRuleExit', () => {
    const r: SymbolReading = {
        date: '2026-01-10',
        price: 120,
        sma200: 100,
        sma5: 115,
        rsi2: 80,
        atrPrev: 2,
    };

    it('never exits on the entry day', () => {
        expect(
            evaluateRuleExit({ reading: r, holdDays: 0, entryDate: '2026-01-10', maxHoldDays: 10 }),
        ).toBeNull();
    });

    it('exits on an MA5 reclaim', () => {
        const exit = evaluateRuleExit({
            reading: r,
            holdDays: 2,
            entryDate: '2026-01-08',
            maxHoldDays: 10,
        });
        expect(exit?.kind).toBe('ma5');
        expect(exit?.reason).toContain('MA5');
    });

    it('exits on the time stop at maxHoldDays, not before', () => {
        const below = { ...r, price: 110 };
        const exit = evaluateRuleExit({
            reading: below,
            holdDays: 10,
            entryDate: '2025-12-20',
            maxHoldDays: 10,
        });
        expect(exit?.kind).toBe('time');
        expect(exit?.reason).toContain('10거래일');
        expect(
            evaluateRuleExit({
                reading: below,
                holdDays: 9,
                entryDate: '2025-12-20',
                maxHoldDays: 10,
            }),
        ).toBeNull();
    });
});
