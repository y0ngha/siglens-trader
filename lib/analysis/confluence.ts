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
 * 마지막 봉이 이보다 낡으면 기권한다 (타임프레임 × 3).
 *
 * 마지막 봉은 형성 중일 수 있고 FMP가 한두 틱 밀리는 것은 정상이라 여유를 둔다.
 * 하루 지연 같은 실제 피드 장애만 걸러내는 것이 목적이다.
 */
const STALE_BAR_LIMIT_MS: Record<AnalysisTimeframe, number> = {
    '15Min': 45 * 60_000,
    '30Min': 90 * 60_000,
    '1Hour': 180 * 60_000,
};

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

        if (!Array.isArray(bars) || bars.length <= MIN_BARS) {
            // 조용한 기권은 "이 축이 영구히 꺼진 심볼"을 관측 불가능하게 만든다.
            // 스냅샷이 null이면 `cron_decisions.detail.confluence`도 null이라 DB만 봐서는
            // 봉이 모자란 것인지 FMP가 죽은 것인지 구분되지 않는다. 로그가 유일한 단서다.
            console.warn(
                '[confluence] 봉 부족으로 기권:',
                symbol,
                timeframe,
                `${Array.isArray(bars) ? bars.length : 0}/${MIN_BARS + 1}`,
            );
            return null;
        }

        const last = bars[bars.length - 1]!;
        if (!isFinitePositive(last.close)) {
            console.warn('[confluence] 마지막 봉 종가가 비정상이라 기권:', symbol, last.close);
            return null;
        }

        // 봉이 낡았으면 기권한다. LLM 5축은 전부 신선도 검사를 지나는데(케이던스 창 ×3,
        // technical은 `getTechnicalMaxAgeMs`) 최상위 가중치인 이 축만 지나지 않았다.
        // FMP 인트라데이 피드가 밀리면 **전 세션 종가**로 진입 트리거가 서고, 같은
        // 스냅샷의 `close`가 execute의 시세 폴백(`snapshotPriceOf`)으로도 쓰여
        // 손절 판정가·dry_run 체결가가 된다.
        const barAgeMs = Date.now() - last.time * 1000;
        if (barAgeMs > STALE_BAR_LIMIT_MS[timeframe]) {
            console.warn(
                '[confluence] 봉이 낡아 기권:',
                symbol,
                timeframe,
                `${Math.round(barAgeMs / 60_000)}분 전`,
            );
            return null;
        }

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
