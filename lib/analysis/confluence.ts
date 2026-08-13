import { calculateIndicators, detectSignals } from '@y0ngha/siglens-core';
import type { Bar, Signal } from '@y0ngha/siglens-core';
import { getMarketDataProvider } from '../data/fmp-market-data-provider.js';
import { CONFLUENCE_MIN } from '../strategy/confluence.js';
import type { ConfluenceSnapshot } from '../strategy/confluence.js';
import type { AnalysisTimeframe } from './timeframe.js';
import { isFinitePositive } from '../validation.js';

/**
 * 시그널 카탈로그가 온전해지는 최소 봉 수 (백테스트 `MIN_BARS`와 동일).
 *
 * `bollinger_squeeze_*` 디텍터가 최근 120봉 밴드폭 백분위를 쓴다. 그 아래에서는
 * 일부 디텍터가 구조적으로 침묵하므로 "약세 3종" 같은 카운트가 왜곡된다.
 * 부족하면 점수를 내지 않고 기권한다.
 */
export const MIN_BARS = 120;

/** SMA 주기. core의 `MA_DEFAULT_PERIODS`에 50이 없어 직접 계산한다. */
const MA_PERIOD = 50;

/**
 * 타임프레임별 봉 조회 룩백(일). 목표는 MIN_BARS의 2~4배 확보.
 * 미국 정규장은 하루 약 6.5시간 → 1Hour ≈ 7봉/일, 30Min ≈ 13, 15Min ≈ 26.
 * 주말·휴장을 감안해 넉넉히 잡되, 15Min에서 수천 봉을 끌어오지 않도록 눌러 둔다.
 */
const LOOKBACK_DAYS: Record<AnalysisTimeframe, number> = {
    '15Min': 30,
    '30Min': 60,
    '1Hour': 120,
};

const MS_PER_DAY = 86_400_000;
const ISO_DATE_LENGTH = 10;

/**
 * 심볼의 현재 지표 컨플루언스 상태를 계산한다.
 *
 * 실패는 전부 `null`이다 — 이 축은 추가 정보이지 매매의 전제조건이 아니고,
 * `scoreSignals`가 `null`을 가중치 0으로 처리해 도입 이전과 동일하게 동작한다.
 *
 * ponytail: FMP 인트라데이 응답의 마지막 봉은 형성 중일 수 있어 봉이 닫히기 전
 * 신호가 번복될 수 있다. 버리면 최대 1타임프레임만큼 늦게 반응하므로 그대로 쓴다.
 * 플리커가 실제 문제가 되면 마지막 봉을 잘라내고 한 틱 늦게 트리거하도록 바꾼다.
 */
export async function computeConfluence(
    symbol: string,
    timeframe: AnalysisTimeframe,
): Promise<ConfluenceSnapshot | null> {
    try {
        const from = isoDaysAgo(LOOKBACK_DAYS[timeframe]);
        const bars = await getMarketDataProvider().getBars({ symbol, timeframe, from });

        if (!Array.isArray(bars) || bars.length <= MIN_BARS) return null;

        const last = bars[bars.length - 1]!;
        if (!isFinitePositive(last.close)) return null;

        const current = detectSignals(bars, calculateIndicators(bars));
        const prevBars = bars.slice(0, -1);
        const previous = detectSignals(prevBars, calculateIndicators(prevBars));

        const bullish = typesOf(current, 'bullish');
        const bearish = typesOf(current, 'bearish');
        const prevBullish = new Set(typesOf(previous, 'bullish'));
        const prevBearish = new Set(typesOf(previous, 'bearish'));

        const freshBullish = bullish.filter((t) => !prevBullish.has(t));
        const freshBearish = bearish.filter((t) => !prevBearish.has(t));

        const ma50 = simpleMovingAverage(bars, MA_PERIOD);

        return {
            timeframe,
            barTime: last.time,
            close: last.close,
            ma50,
            bullish,
            bearish,
            freshBullish,
            freshBearish,
            // 종가는 MA50보다 크거나 작거나 하나뿐이므로 두 트리거는 구조적으로 상호배타다.
            entryTrigger:
                bullish.length >= CONFLUENCE_MIN &&
                freshBullish.length >= 1 &&
                ma50 !== null &&
                last.close > ma50,
            exitTrigger:
                bearish.length >= CONFLUENCE_MIN &&
                freshBearish.length >= 1 &&
                ma50 !== null &&
                last.close < ma50,
        };
    } catch (error) {
        console.warn('[confluence] 계산 실패:', symbol, timeframe, error);
        return null;
    }
}

/** 방향별 시그널 타입 목록. 중복 제거 후 정렬 — 스냅샷이 감사 로그로 남으므로 순서가 안정적이어야 한다. */
function typesOf(signals: readonly Signal[], direction: 'bullish' | 'bearish'): string[] {
    const set = new Set<string>();
    for (const s of signals) {
        if (s.direction === direction && typeof s.type === 'string') set.add(s.type);
    }
    return [...set].sort();
}

/** 마지막 `period`개 종가의 단순 평균. 봉이 모자라거나 값이 비정상이면 null. */
function simpleMovingAverage(bars: Bar[], period: number): number | null {
    if (bars.length < period) return null;
    let sum = 0;
    for (let i = bars.length - period; i < bars.length; i++) {
        const close = bars[i]!.close;
        if (!Number.isFinite(close)) return null;
        sum += close;
    }
    const ma = sum / period;
    return Number.isFinite(ma) ? ma : null;
}

/** `days`일 전 날짜의 `YYYY-MM-DD`. provider가 앞 10자만 쓰므로 이 형태로 넘긴다. */
function isoDaysAgo(days: number): string {
    return new Date(Date.now() - days * MS_PER_DAY).toISOString().substring(0, ISO_DATE_LENGTH);
}
