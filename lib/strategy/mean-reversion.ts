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
/**
 * 소프트 국면 캡의 SPY 이동평균 기간. 설정이 아니다 — 백테스트가 50일선에서만 재어졌고(스펙 §13),
 * 기간을 열어 두면 검증되지 않은 값을 운영자가 고를 수 있다.
 */
export const SOFT_REGIME_MA_PERIOD = 50;
/** 소프트 국면 캡의 동시 보유 상한 범위·기본값. `api/config.ts`의 `NUMERIC_BOUNDS`와 같아야 한다. */
export const SOFT_REGIME_MIN_POSITIONS = 1;
export const SOFT_REGIME_MAX_POSITIONS = 8;
export const SOFT_REGIME_DEFAULT_POSITIONS = 4;

export interface MeanReversionParams {
    /** RSI(2)가 이 값 **미만**이면 진입 후보. */
    rsiEntry: number;
    /** 진입일 이후 거래일 수가 이 값 이상이면 청산. */
    maxHoldDays: number;
    /** 재난 손절 = 진입가 − stopAtr × ATR(14). 0이면 손절 없음. */
    stopAtr: number;
    /** 켜져 있으면 SPY > SMA200일 때만 진입. */
    regimeFilter: boolean;
    /**
     * 켜져 있고 SPY 종가 ≤ SMA50이면 열린 포지션 수가 `softRegimeMaxPositions`에 닿을 때까지만
     * **신규** 진입을 낸다. 기존 포지션은 건드리지 않는다(원칙 7). 기본 OFF — 근거가 중간 수준이라 옵션이다(원칙 13).
     */
    softRegimeEnabled: boolean;
    /** 소프트 캡의 동시 보유 상한(1~8 정수). */
    softRegimeMaxPositions: number;
}

export const DEFAULT_MR_PARAMS: MeanReversionParams = {
    rsiEntry: 10,
    maxHoldDays: 10,
    stopAtr: 10,
    regimeFilter: true,
    softRegimeEnabled: false,
    softRegimeMaxPositions: SOFT_REGIME_DEFAULT_POSITIONS,
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
    /** 같은 SPY 계열(마지막 봉 = 오늘의 실시간 가격)의 50일 평균 — 소프트 캡이 쓴다. SMA200이 되면 항상 50봉 이상이다. */
    sma50: number;
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
    const sma50 = sma(
        spyBars.map((b) => b.close),
        SOFT_REGIME_MA_PERIOD,
    )!;
    return { up: price > sma200, price, sma200, sma50 };
}

/** 국면 판독이 필요한가 — 하드 필터나 소프트 캡 중 하나라도 켜져 있으면 SPY를 읽어야 한다. */
export function needsRegime(params: MeanReversionParams): boolean {
    return params.regimeFilter || params.softRegimeEnabled;
}

/** 소프트 캡의 그날 판독 — 감사 기록(`detail.mr.softRegime`)과 진입 예산이 같은 값에서 나온다. */
export interface SoftRegimeReading {
    enabled: boolean;
    /** 켜져 있고 SPY ≤ SMA50(또는 오늘의 첫 판독을 재사용, 또는 SPY를 못 읽어 활성으로 가정). */
    active: boolean;
    spyPrice: number | null;
    spySma50: number | null;
    /** 검증을 통과한 상한(범위 밖이면 기본값). */
    cap: number;
    openPositions: number;
    /**
     * 신규 진입 여유분 = max(0, cap − 열린 포지션). 비활성이면 null(제한 없음 — 기존 예산만 따른다).
     */
    room: number | null;
    /** SPY를 못 읽어 `active`를 가정했다(실제 판독이 아니다). 같은 날 재사용 대상에서 제외된다. */
    assumed: boolean;
    /** 같은 ET 날짜의 앞선 런이 남긴 실제 판독의 `active`를 그대로 썼다(경계 왕복 방지). */
    locked: boolean;
}

/**
 * 소프트 국면 캡. SPY 종가가 SMA50 **이하**(같으면 포함)이면 동시 보유를 `softRegimeMaxPositions`로
 * 묶는다 — 백테스트와 같은 비교(`close <= sma50`)다. 신규 진입만 줄이고 기존 포지션·청산은 건드리지 않는다.
 *
 * - `lockedActive`(같은 ET 날짜 앞선 런의 실제 판독)가 있으면 그 값을 쓴다 — 판단 재시도 틱에서 SPY가 50일선
 *   경계를 오가도 캡이 켜졌다 꺼지지 않는다. 앞선 판독이 없으면 지금 판독을 쓴다.
 * - SPY를 못 읽으면(`regime === null`, 재사용할 판독도 없음) 켜진 캡을 **활성으로 가정**한다. 여유는
 *   `cap − 열린 포지션`이라 진입 자체는 막지 않는다 — 캡만 켠 운영자에게 SPY 결측이 "그날 진입 전체 금지"가
 *   되는 것은 비례하지 않기 때문이다. 하드 필터(SMA200)가 켜져 있으면 호출자(execute)가 이 판독에 닿기 전에
 *   fail-closed로 진입을 멈춘다.
 * - 상한이 1~8 정수가 아니면 기본값 4로 되돌린다(`readMrParams`와 같은 손상 행 방어).
 * - 열린 포지션 수가 유한 정수가 아니면 여유 0이다 — 모르는 상태로 사지 않는다.
 */
export function softRegimeCap(
    regime: RegimeReading | null,
    params: Pick<MeanReversionParams, 'softRegimeEnabled' | 'softRegimeMaxPositions'>,
    openPositions: number,
    lockedActive: boolean | null = null,
): SoftRegimeReading {
    const rawCap = params.softRegimeMaxPositions;
    const cap =
        Number.isInteger(rawCap) &&
        rawCap >= SOFT_REGIME_MIN_POSITIONS &&
        rawCap <= SOFT_REGIME_MAX_POSITIONS
            ? rawCap
            : SOFT_REGIME_DEFAULT_POSITIONS;
    const openKnown = Number.isInteger(openPositions) && openPositions >= 0;
    const base = {
        enabled: params.softRegimeEnabled,
        spyPrice: regime?.price ?? null,
        spySma50: regime?.sma50 ?? null,
        cap,
        openPositions: openKnown ? openPositions : cap,
    };
    if (!params.softRegimeEnabled) {
        return { ...base, active: false, room: null, assumed: false, locked: false };
    }
    const locked = lockedActive !== null;
    const assumed = !locked && regime === null;
    const active = locked ? lockedActive : regime === null || regime.price <= regime.sma50;
    if (!active) return { ...base, active: false, room: null, assumed, locked };
    const room = openKnown ? Math.max(0, cap - openPositions) : 0;
    return { ...base, active: true, room, assumed, locked };
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
 * MA5 회복 청산이 켜지는 오늘 종가 — `P > (직전 4종가 합 + P) / 5` ⇔ `P > 직전 4종가 평균`.
 * 마지막 봉 = 오늘(`readSymbol`과 같은 전제). 봉이 모자라면 null.
 */
export function ma5ExitPrice(bars: readonly DailyBar[]): number | null {
    return sma(
        bars.slice(0, -1).map((b) => b.close),
        EXIT_MA_PERIOD - 1,
    );
}

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
