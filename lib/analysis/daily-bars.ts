import { getMarketDataProvider } from '../data/fmp-market-data-provider.js';
import type { DailyBar } from '../strategy/mean-reversion.js';

/**
 * SMA(200) + 여유. 400 달력일 ≈ 275 거래일 — Wilder RSI(2)·ATR(14)의 시드 효과도 그 안에서 사라진다.
 */
const LOOKBACK_DAYS = 400;
const MS_PER_DAY = 86_400_000;

const ET_DATE = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

/** ET 거래일 `YYYY-MM-DD`. 서머타임을 `Intl`이 처리한다. */
export function etDateOf(d: Date): string {
    return ET_DATE.format(d);
}

const ET_CLOCK = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

/** ET 자정부터 지난 분. */
export function etMinutesOfDay(d: Date): number {
    const parts = ET_CLOCK.formatToParts(d);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    return hour * 60 + minute;
}

/**
 * `now`가 속한 ET 날짜의 자정(UTC 시각). 서머타임이면 04:00Z, 아니면 05:00Z.
 * "오늘의 판단"(`hasDecisionPhaseSince`)과 "오늘의 신호"(리뷰 대상)의 시작점이다.
 */
export function etDayStart(now: Date): Date {
    const date = etDateOf(now);
    // ET 자정의 오프셋은 그날 2시 전환 **이전**의 것이다. 04:00Z가 ET 자정이면 EDT, 아니면 EST.
    const edtMidnight = new Date(Date.parse(`${date}T04:00:00Z`));
    return etMinutesOfDay(edtMidnight) === 0
        ? edtMidnight
        : new Date(Date.parse(`${date}T05:00:00Z`));
}

const positive = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/**
 * 판단용 일봉 계열 — 마지막 봉이 오늘이고 그 종가가 실시간 가격이다(스펙 §4.3).
 *
 * 공급자(`getDailyBars`)는 EOD 계열에 오늘 행이 없으면 quote로 만든 오늘 봉을 이미 붙여 준다.
 * 그래도 두 경우를 다 처리한다: 마지막 봉이 오늘(ET)이면 종가를 실시간 가격으로 바꾸고 고가·저가를
 * 넓히고, 아니면(공급자의 quote 조회 실패) 실시간 가격으로 합성 봉을 붙인다. 실시간 가격이 없으면
 * 공급자 계열 그대로 쓴다 — 재난 손절가 백필처럼 전일까지의 봉만 필요한 호출이 있다.
 *
 * 조회 실패·빈 계열은 null. 호출자는 그것을 `mr_data_error`로 남긴다 — "신호 없음"과 "고장"이
 * 로그에서 구분돼야 한다(원칙 11).
 */
export async function fetchDailyBars(
    symbol: string,
    livePrice: number | null,
    now: Date,
): Promise<DailyBar[] | null> {
    let raw;
    try {
        const from = new Date(now.getTime() - LOOKBACK_DAYS * MS_PER_DAY)
            .toISOString()
            .slice(0, 10);
        raw = await getMarketDataProvider().getBars({ symbol, timeframe: '1Day', from });
    } catch (error) {
        console.warn('[daily-bars] 일봉 조회 실패:', symbol, error);
        return null;
    }
    if (!Array.isArray(raw) || raw.length === 0) return null;

    const bars: DailyBar[] = raw.map((b) => ({
        // 공급자는 일봉 시각을 그 날짜의 UTC 자정으로 준다 — 날짜 문자열로 되돌리면 ET 거래일이다.
        date: new Date(b.time * 1000).toISOString().slice(0, 10),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
    }));
    if (!positive(livePrice)) return bars;

    const today = etDateOf(now);
    const last = bars[bars.length - 1]!;
    if (last.date === today) {
        bars[bars.length - 1] = {
            ...last,
            close: livePrice,
            high: Math.max(last.high, livePrice),
            low: Math.min(last.low, livePrice),
        };
    } else if (last.date < today) {
        bars.push({
            date: today,
            open: livePrice,
            high: livePrice,
            low: livePrice,
            close: livePrice,
        });
    }
    return bars;
}
