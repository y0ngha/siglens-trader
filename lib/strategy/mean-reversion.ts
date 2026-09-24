/**
 * 일봉 RSI(2) 눌림매수 — 매매 규칙 전부. 순수 함수, I/O 없음.
 *
 * 근거와 한계: `docs/specs/2026-09-24-daily-mean-reversion-design.md` (§2 백테스트, §3 규칙).
 *
 * **지표 식은 백테스트 스크립트(스펙 §12)와 같다.** 동등성 테스트가 실제 FMP 일봉에서 같은 날에
 * 같은 신호가 나는지 고정한다. 식을 바꾸면 백테스트가 뒷받침하던 규칙이 아니게 되므로, 바꿀 때는
 * 백테스트를 다시 돌리고 픽스처를 다시 만든다.
 */

/** 일봉 1개. `date`는 ET 거래일 `YYYY-MM-DD`. 판단 시점 계열의 마지막 봉 `close`는 오늘의 실시간 가격이다. */
export interface DailyBar {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
}

/** 규칙의 정체성이라 설정으로 빼지 않는다(스펙 §3). */
export const TREND_MA_PERIOD = 200;
export const EXIT_MA_PERIOD = 5;
export const RSI_PERIOD = 2;
export const ATR_PERIOD = 14;

export interface MeanReversionParams {
    /** RSI(2)가 이 값 **미만**이면 진입 후보. */
    rsiEntry: number;
    /** 진입일 이후 거래일 수가 이 값 이상이면 청산. */
    maxHoldDays: number;
    /** 재난 손절 = 진입가 − stopAtr × ATR(14). 0이면 손절 없음. */
    stopAtr: number;
    /** 켜져 있으면 SPY > SMA200일 때만 진입. */
    regimeFilter: boolean;
}

export const DEFAULT_MR_PARAMS: MeanReversionParams = {
    rsiEntry: 10,
    maxHoldDays: 10,
    stopAtr: 5,
    regimeFilter: true,
};

const finitePositive = (x: unknown): x is number =>
    typeof x === 'number' && Number.isFinite(x) && x > 0;

/** 마지막 `period`개의 산술평균. 길이가 모자라면 null. */
export function sma(values: readonly number[], period: number): number | null {
    if (period <= 0 || values.length < period) return null;
    let sum = 0;
    for (let i = values.length - period; i < values.length; i++) sum += values[i]!;
    return sum / period;
}

/**
 * Wilder 평활의 마지막 값. 인덱스 0부터 첫 `period`개의 단순평균으로 시드하고, 이후
 * `(prev × (period − 1) + x) / period`. 백테스트의 `wilder()`와 같은 식이다.
 *
 * 전제: `values.length >= period` — 두 호출자가 먼저 길이를 검사한다.
 */
function wilderLast(values: readonly number[], period: number): number {
    let acc = 0;
    for (let i = 0; i < period; i++) acc += values[i]!;
    let out = acc / period;
    for (let i = period; i < values.length; i++) out = (out * (period - 1) + values[i]!) / period;
    return out;
}

/** Wilder RSI의 마지막 값. 첫 변화량은 0으로 둔다(백테스트와 같음). */
export function wilderRsi(closes: readonly number[], period: number): number | null {
    if (closes.length < period + 1) return null;
    const changes = closes.map((c, i) => (i === 0 ? 0 : c - closes[i - 1]!));
    const gain = wilderLast(
        changes.map((x) => Math.max(x, 0)),
        period,
    );
    const loss = wilderLast(
        changes.map((x) => Math.max(-x, 0)),
        period,
    );
    if (loss === 0) return 100;
    return 100 - 100 / (1 + gain / loss);
}

/** Wilder ATR의 마지막 값. 첫 봉의 TR은 고가 − 저가(백테스트와 같음). */
export function wilderAtr(bars: readonly DailyBar[], period: number): number | null {
    if (bars.length < period) return null;
    const trueRanges = bars.map((b, i) =>
        i === 0
            ? b.high - b.low
            : Math.max(
                  b.high - b.low,
                  Math.abs(b.high - bars[i - 1]!.close),
                  Math.abs(b.low - bars[i - 1]!.close),
              ),
    );
    return wilderLast(trueRanges, period);
}

/** 한 종목의 판단 재료. 마지막 봉 = 오늘. */
export interface SymbolReading {
    date: string;
    price: number;
    sma200: number;
    sma5: number;
    rsi2: number;
    /**
     * 오늘 봉을 **제외한** ATR(14). 장중 오늘 봉은 고가·저가가 아직 덜 찼으므로 재난 손절 폭에는
     * 전일까지의 변동성을 쓴다(스펙 §3). 봉이 모자라면 null.
     */
    atrPrev: number | null;
}

/**
 * 200봉 미만(최근 상장)이거나 마지막 종가가 비정상이면 null — 판단 불가는 신호 없음이다(스펙 §3).
 */
export function readSymbol(bars: readonly DailyBar[]): SymbolReading | null {
    if (bars.length < TREND_MA_PERIOD) return null;
    const last = bars[bars.length - 1]!;
    if (!finitePositive(last.close)) return null;
    const closes = bars.map((b) => b.close);
    return {
        date: last.date,
        price: last.close,
        sma200: sma(closes, TREND_MA_PERIOD)!,
        sma5: sma(closes, EXIT_MA_PERIOD)!,
        rsi2: wilderRsi(closes, RSI_PERIOD)!,
        atrPrev: wilderAtr(bars.slice(0, -1), ATR_PERIOD),
    };
}

export interface RegimeReading {
    up: boolean;
    price: number;
    sma200: number;
}

/**
 * SPY 국면. 판단 불가면 null — 국면 필터가 켜져 있으면 그날 진입을 하지 않는다(fail-closed, 스펙 §3).
 */
export function readRegime(spyBars: readonly DailyBar[]): RegimeReading | null {
    if (spyBars.length < TREND_MA_PERIOD) return null;
    const price = spyBars[spyBars.length - 1]!.close;
    if (!finitePositive(price)) return null;
    const sma200 = sma(
        spyBars.map((b) => b.close),
        TREND_MA_PERIOD,
    )!;
    return { up: price > sma200, price, sma200 };
}

export function isEntrySignal(
    reading: SymbolReading,
    regime: RegimeReading | null,
    params: MeanReversionParams,
): boolean {
    if (!(reading.price > reading.sma200)) return false;
    if (!(reading.rsi2 < params.rsiEntry)) return false;
    if (params.regimeFilter && regime?.up !== true) return false;
    return true;
}

/** 예산보다 신호가 많을 때의 우선순위 — RSI(2) 오름차순(스펙 §3). 입력 배열은 바꾸지 않는다. */
export function rankSignals<T extends { rsi2: number }>(signals: readonly T[]): T[] {
    return [...signals].sort((a, b) => a.rsi2 - b.rsi2);
}

/** 재난 손절가. 배수 0·ATR 없음·결과가 0 이하이면 null(손절 없음). */
export function stopPriceFor(
    entryPrice: number,
    atrPrev: number | null,
    stopAtr: number,
): number | null {
    if (!(stopAtr > 0) || atrPrev === null || !Number.isFinite(atrPrev)) return null;
    const stop = entryPrice - stopAtr * atrPrev;
    return stop > 0 ? stop : null;
}

export function isStopHit(price: number, stopPrice: number | null): boolean {
    return stopPrice !== null && price <= stopPrice;
}

/**
 * 진입일보다 뒤인 **서로 다른** 날짜의 개수. 공급자가 오늘 행을 주든 합성 봉이든 오늘은 한 번만
 * 센다(스펙 §3). 달력 로직이 필요 없다 — 일봉이 곧 거래일 목록이다.
 */
export function holdDays(bars: readonly DailyBar[], entryDate: string): number {
    const dates = new Set<string>();
    for (const b of bars) if (b.date > entryDate) dates.add(b.date);
    return dates.size;
}

export type RuleExit = { kind: 'ma5' | 'time'; reason: string } | null;

/**
 * 판단 틱의 규칙 청산 — MA5 회복, 보유 기간. **진입 당일은 판단하지 않는다**(백테스트는 진입 다음
 * 날부터 청산을 봤다). 재난 손절은 매 틱 `isStopHit`으로 따로 본다.
 */
export function evaluateRuleExit(p: {
    reading: SymbolReading;
    holdDays: number;
    entryDate: string;
    maxHoldDays: number;
}): RuleExit {
    if (p.reading.date <= p.entryDate) return null;
    if (p.reading.price > p.reading.sma5) {
        return {
            kind: 'ma5',
            reason: `MA5 회복 (현재 $${p.reading.price.toFixed(2)} > MA5 $${p.reading.sma5.toFixed(2)})`,
        };
    }
    if (p.holdDays >= p.maxHoldDays) {
        return {
            kind: 'time',
            reason: `보유 기간 ${p.holdDays}거래일 도달 (한도 ${p.maxHoldDays})`,
        };
    }
    return null;
}
