import { calculateIndicators, classifyTrend, detectSignals } from '@y0ngha/siglens-core';
import type { Bar, Signal, TrendState } from '@y0ngha/siglens-core';
import { getMarketDataProvider } from '../data/fmp-market-data-provider.js';
import {
    CONFLUENCE_EXPECTED_WEIGHT,
    CONFLUENCE_MIN,
    CONFLUENCE_SPAN,
    confluenceFamilyWeight,
    signalFamily,
    VOLUME_FAMILIES,
} from '../strategy/confluence.js';
import type { ConfluenceParams, ConfluenceSnapshot } from '../strategy/confluence.js';
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

/** 상위 시간축 기본값. 30분봉 진입을 일봉 추세에 정렬시킨다. */
export const DEFAULT_HTF_TIMEFRAME = '1Day';

/**
 * 상위 시간축 봉 캐시 TTL.
 *
 * 일봉은 장 마감 후에만 바뀌는데 execute는 10분마다 돈다. 캐시가 없으면 종목당 하루
 * ~39회 FMP를 더 부르게 되고, 그 호출의 답은 전부 같다. 1시간이면 장중 갱신 지연이
 * 추세 판정(EMA 기울기)에 영향을 줄 수준이 아니다.
 */
const HTF_CACHE_TTL_MS = 60 * 60_000;

/**
 * **실패**한 판정의 캐시 TTL. 성공보다 훨씬 짧다.
 *
 * 실패를 1시간 캐시하면 FMP가 한 번 딸꾹한 것으로 그 종목의 정렬 게이트가 execute 6틱 동안
 * 꺼진다. fail-open이라 방향은 안전하지만, 일시적 장애를 6배로 늘려 줄 이유가 없다.
 * 다음 틱에 다시 시도하되 매 틱 두드리지는 않는 간격이다.
 */
const HTF_FAILURE_CACHE_TTL_MS = 5 * 60_000;

/** 상위 시간축 추세 판정에 필요한 최소 봉 수 (EMA 워밍업 여유 포함). */
const HTF_MIN_BARS = 60;

const htfCache = new Map<string, { at: number; trend: TrendState | null }>();

/** 테스트 전용 — 모듈 캐시를 비운다. */
export function __clearHtfCache(): void {
    htfCache.clear();
}

/**
 * 상위 시간축 추세. 조회·판정 실패는 전부 `null`이고, 호출부는 그때 정렬 게이트를 끈다.
 *
 * core의 `classifyTrend`를 쓴다 — EMA 기울기 + 종가 위치로 판정하는 도메인 로직이고,
 * 여기서 다시 구현할 이유가 없다.
 */
async function fetchHtfTrend(symbol: string, htf: string): Promise<TrendState | null> {
    const key = `${symbol}:${htf}`;
    const hit = htfCache.get(key);
    if (hit) {
        const ttl = hit.trend === null ? HTF_FAILURE_CACHE_TTL_MS : HTF_CACHE_TTL_MS;
        if (Date.now() - hit.at < ttl) return hit.trend;
    }

    let trend: TrendState | null = null;
    try {
        const from = isoDaysAgo(htf === '1Day' ? 400 : 60);
        const bars = await getMarketDataProvider().getBars({
            symbol,
            timeframe: htf as AnalysisTimeframe,
            from,
        });
        if (Array.isArray(bars) && bars.length >= HTF_MIN_BARS) {
            trend = classifyTrend(bars, calculateIndicators(bars));
        } else {
            console.warn('[confluence] 상위 시간축 봉 부족:', symbol, htf, bars?.length ?? 0);
        }
    } catch (error) {
        console.warn('[confluence] 상위 시간축 조회 실패:', symbol, htf, error);
    }
    htfCache.set(key, { at: Date.now(), trend });
    return trend;
}

/** 튜너블. 전부 `config`에서 오고, 호출부(execute cron)가 읽어 넘긴다. */
export interface ConfluenceOptions {
    /** 트리거에 필요한 가중 계열 수. 기본 {@link CONFLUENCE_MIN}. */
    min?: number;
    /** 연속 점수 폭. 기본 {@link CONFLUENCE_SPAN}. */
    span?: number;
    /** `expected` phase 표 가중치. 기본 {@link CONFLUENCE_EXPECTED_WEIGHT}. */
    expectedWeight?: number;
    /** 상위 시간축. `null`이면 정렬 게이트를 끈다. 기본 {@link DEFAULT_HTF_TIMEFRAME}. */
    htf?: string | null;
    /** 강세 계열에 거래량 계열이 최소 하나 있어야 진입 트리거가 서는가. 기본 true. */
    requireVolume?: boolean;
}

function resolveParams(opts: ConfluenceOptions | undefined): ConfluenceParams {
    const num = (v: unknown, fallback: number, min = 0): number =>
        typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback;
    return {
        min: num(opts?.min, CONFLUENCE_MIN, 0),
        span: num(opts?.span, CONFLUENCE_SPAN, 0),
        expectedWeight: Math.min(num(opts?.expectedWeight, CONFLUENCE_EXPECTED_WEIGHT, 0), 1),
        htf: opts?.htf === null ? null : (opts?.htf ?? DEFAULT_HTF_TIMEFRAME),
        requireVolume: opts?.requireVolume ?? true,
    };
}

/** 강세 계열 중 거래량 계열(cmf/mfi)이 하나라도 있는가. */
function hasVolumeBacking(types: readonly string[]): boolean {
    return types.some((t) => VOLUME_FAMILIES.has(signalFamily(t)));
}

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
    opts?: ConfluenceOptions,
): Promise<ConfluenceSnapshot | null> {
    const params = resolveParams(opts);
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

        // 상위 시간축 정렬. 같은 30분봉의 MA50은 약 3.8거래일 평균이라 "중기 추세 필터"가
        // 아니다 — 백테스트에서 그 이름이 붙은 건 일봉이었기 때문이다. 장중 롱을 상위
        // 추세가 무너지는 국면에 넣는 것이 장중 손실의 대표 원인이라, 진짜 상위 봉을 따로
        // 본다. 실패는 null이고 그때는 이 조건을 적용하지 않는다.
        const htfTrend = params.htf === null ? null : await fetchHtfTrend(symbol, params.htf);
        const htfAligned = htfTrend === null || htfTrend === 'uptrend';

        // 거래량이 받쳐주지 않는 합류는 되돌림이 되기 쉽다. core의 CMF/MFI는 여태 다른
        // 시그널과 같은 한 표였을 뿐 게이트가 아니었다.
        const volumeOk = !params.requireVolume || hasVolumeBacking(bullish);

        return {
            timeframe,
            barTime: last.time,
            close: last.close,
            ma50,
            bullish,
            bearish,
            freshBullish,
            freshBearish,
            htfTrend,
            params,
            // 종가는 MA50보다 크거나 작거나 하나뿐이므로 두 트리거는 구조적으로 상호배타다.
            //
            // 타입 수가 아니라 **가중 계열 수**를 센다 — 볼린저 3종은 지표 하나이고,
            // `support_proximity_bullish` 같은 상태값은 반표다. 조이는 방향으로만 작동하므로
            // 종전에 서지 않던 트리거가 새로 서는 일은 없다. 근거는
            // `lib/strategy/confluence.ts`의 `CONFLUENCE_MIN` / `SIGNAL_FAMILY` 주석.
            entryTrigger:
                confluenceFamilyWeight(bullish, params.expectedWeight) >= params.min &&
                freshBullish.length >= 1 &&
                ma50 !== null &&
                last.close > ma50 &&
                htfAligned &&
                volumeOk,
            // **청산에는 정렬·거래량 게이트를 걸지 않는다.** 둘 다 트리거를 어렵게 만드는
            // 조건이고, 진입이 어려워지는 건 목적이지만 청산이 어려워지는 건 정반대다
            // (원칙 7). 놓친 매수는 기회비용이고 놓친 매도는 실현 손실이다.
            exitTrigger:
                confluenceFamilyWeight(bearish, params.expectedWeight) >= params.min &&
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
