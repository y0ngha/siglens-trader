import { evaluateConfluence } from '@y0ngha/siglens-core';
import type { Bar, ConfluenceSnapshot } from '@y0ngha/siglens-core';
import { getMarketDataProvider } from '../data/fmp-market-data-provider.js';
import { CONFLUENCE_MIN_BARS } from '../strategy/confluence.js';
import type { AnalysisTimeframe } from './timeframe.js';
import { isFinitePositive } from '../validation.js';

/**
 * 시그널 카탈로그가 온전해지는 최소 봉 수. 판정 자체는 core가 하고
 * (`CONFLUENCE_MIN_BARS`), 여기서는 조회량 판단과 기권 로그에 쓴다.
 */
export const MIN_BARS = CONFLUENCE_MIN_BARS;

/** 상위 시간축 기본값. 30분봉 진입을 일봉 추세에 정렬시킨다. */
export const DEFAULT_HTF_TIMEFRAME = '1Day';

/**
 * 상위 시간축 봉 캐시 TTL.
 *
 * 일봉은 장 마감 후에만 바뀌는데 execute는 10분마다 돈다. 캐시가 없으면 종목당 하루
 * ~39회 FMP를 더 부르게 되고, 그 호출의 답은 전부 같다.
 */
const HTF_CACHE_TTL_MS = 60 * 60_000;

/**
 * **실패**한 조회의 캐시 TTL. 성공보다 훨씬 짧다.
 *
 * 실패를 1시간 캐시하면 FMP가 한 번 딸꾹한 것으로 그 종목의 정렬 게이트가 execute
 * 6틱 동안 꺼진다. fail-open이라 방향은 안전하지만 일시적 장애를 6배로 늘릴 이유가 없다.
 */
const HTF_FAILURE_CACHE_TTL_MS = 5 * 60_000;

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

/** 상위 시간축 룩백(일). 일봉이면 EMA 워밍업까지 넉넉히 본다. */
const HTF_LOOKBACK_DAYS: Record<string, number> = { '1Day': 400 };
const HTF_LOOKBACK_DEFAULT_DAYS = 60;

const MS_PER_DAY = 86_400_000;
const ISO_DATE_LENGTH = 10;

/**
 * 마지막 봉이 이보다 낡으면 기권한다 (타임프레임 × 3).
 *
 * 마지막 봉은 형성 중일 수 있고 FMP가 한두 틱 밀리는 것은 정상이라 여유를 둔다.
 * 하루 지연 같은 실제 피드 장애만 걸러내는 것이 목적이다. 이 검사가 core가 아니라
 * 여기 있는 이유 — `Date.now()`를 읽으므로 순수 함수가 아니고, 피드 건강은 소비자
 * 관심사다.
 */
const STALE_BAR_LIMIT_MS: Record<AnalysisTimeframe, number> = {
    '15Min': 45 * 60_000,
    '30Min': 90 * 60_000,
    '1Hour': 180 * 60_000,
};

const htfCache = new Map<string, { at: number; bars: Bar[] | null }>();

/** 테스트 전용 — 모듈 캐시를 비운다. */
export function __clearHtfCache(): void {
    htfCache.clear();
}

/** 튜너블. 전부 `config`에서 오고, 호출부(execute cron)가 읽어 넘긴다. */
export interface ConfluenceOptions {
    /** 트리거에 필요한 가중 계열 수. */
    min?: number;
    /** 연속 점수 폭. */
    span?: number;
    /** `expected` phase 표 가중치. */
    expectedWeight?: number;
    /** 상위 시간축. `null`이면 정렬 게이트를 끈다. 기본 {@link DEFAULT_HTF_TIMEFRAME}. */
    htf?: string | null;
    /** 강세 계열에 거래량 계열이 최소 하나 있어야 진입 트리거가 서는가. 기본 true. */
    requireVolume?: boolean;
}

/**
 * 심볼의 현재 지표 컨플루언스 상태를 계산한다.
 *
 * **이 파일은 봉을 구해 오는 일만 한다.** 룰과 채점은 core의 `evaluateConfluence`가
 * 소유한다 — 봉 조회는 소비자 책임, 도메인 계산은 core 책임이라는 분업이다. 덕분에
 * siglens 백테스트와 실거래가 같은 함수를 부른다.
 *
 * 실패는 전부 `null`이다 — 이 축은 추가 정보이지 매매의 전제조건이 아니고,
 * `scoreSignals`가 `null`을 가중치 0으로 처리해 도입 이전과 동일하게 동작한다.
 *
 * ponytail: FMP 인트라데이 응답의 마지막 봉은 형성 중일 수 있어 봉이 닫히기 전
 * 신호가 번복될 수 있다. 버리면 최대 1타임프레임만큼 늦게 반응하므로 그대로 쓴다.
 */
export async function computeConfluence(
    symbol: string,
    timeframe: AnalysisTimeframe,
    opts?: ConfluenceOptions,
): Promise<ConfluenceSnapshot | null> {
    const htf = opts?.htf === null ? null : (opts?.htf ?? DEFAULT_HTF_TIMEFRAME);
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

        const htfBars = htf === null ? null : await fetchHtfBars(symbol, htf);

        return evaluateConfluence(bars, {
            timeframe,
            htfBars,
            htfLabel: htf,
            minBars: MIN_BARS,
            ...(typeof opts?.min === 'number' ? { min: opts.min } : {}),
            ...(typeof opts?.span === 'number' ? { span: opts.span } : {}),
            ...(typeof opts?.expectedWeight === 'number'
                ? { expectedWeight: opts.expectedWeight }
                : {}),
            ...(typeof opts?.requireVolume === 'boolean'
                ? { requireVolume: opts.requireVolume }
                : {}),
        });
    } catch (error) {
        console.warn('[confluence] 계산 실패:', symbol, timeframe, error);
        return null;
    }
}

/**
 * 상위 시간축 봉. 조회 실패는 `null`이고, core는 그때 정렬 게이트를 적용하지 않는다.
 *
 * 추세 판정 자체는 core가 한다 — 여기서는 봉만 구한다.
 */
async function fetchHtfBars(symbol: string, htf: string): Promise<Bar[] | null> {
    const key = `${symbol}:${htf}`;
    const hit = htfCache.get(key);
    if (hit) {
        const ttl = hit.bars === null ? HTF_FAILURE_CACHE_TTL_MS : HTF_CACHE_TTL_MS;
        if (Date.now() - hit.at < ttl) return hit.bars;
    }

    let bars: Bar[] | null = null;
    try {
        const from = isoDaysAgo(HTF_LOOKBACK_DAYS[htf] ?? HTF_LOOKBACK_DEFAULT_DAYS);
        const fetched = await getMarketDataProvider().getBars({
            symbol,
            timeframe: htf as AnalysisTimeframe,
            from,
        });
        if (Array.isArray(fetched) && fetched.length > 0) bars = fetched;
        else console.warn('[confluence] 상위 시간축 봉 없음:', symbol, htf);
    } catch (error) {
        console.warn('[confluence] 상위 시간축 조회 실패:', symbol, htf, error);
    }
    htfCache.set(key, { at: Date.now(), bars });
    return bars;
}

/** `days`일 전 날짜의 `YYYY-MM-DD`. */
function isoDaysAgo(days: number): string {
    return new Date(Date.now() - days * MS_PER_DAY).toISOString().slice(0, ISO_DATE_LENGTH);
}
