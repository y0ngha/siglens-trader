/**
 * 지표 컨플루언스 신호 — 순수 도메인.
 *
 * siglens 백테스트(2024.04–2026.04, 100케이스, 승률 70%)가 이긴 진입 룰을 점수화한다.
 * 룰 원문: 동시 활성 bullish 시그널 3종 이상 + 그중 1종 이상 신규 + 종가 > SMA(50).
 *
 * 이 파일은 I/O를 하지 않는다. 봉 조회와 siglens-core 지표 계산은
 * `lib/analysis/confluence.ts`가 담당하고, 여기에는 그 결과(스냅샷)만 들어온다.
 */

/** 백테스트 `MIN_CONFLUENCE`. 이 수 이상의 서로 다른 시그널 타입이 동시에 켜져야 트리거. */
export const CONFLUENCE_MIN = 3;

/** 중립 50을 기준으로 한 연속 점수 폭 → 20..80. 다른 축(technical 35 / fundamental 30)과 같은 관례. */
export const CONFLUENCE_SPAN = 30;

/**
 * 소표본 축소(pseudo-count). 방향 신호 1개가 0/100으로 튀지 않게 50 쪽으로 당긴다.
 * `signal-scorer.ts`의 옵션 축(`OPTIONS_SHRINK_K`)과 동일한 기법.
 */
export const CONFLUENCE_SHRINK = 1;

/** 진입 트리거 성립 시의 최소 점수. */
export const CONFLUENCE_TRIGGER_SCORE = 92;

/** 청산 트리거 성립 시의 최대 점수. */
export const CONFLUENCE_EXIT_SCORE = 8;

/**
 * 한 심볼·한 봉 시점의 컨플루언스 상태.
 *
 * `Signal` 객체가 아니라 `SignalType` 문자열 배열만 담는다 — 이 값은 그대로
 * `cron_decisions.detail`(JSONB)과 trade-gate 프롬프트에 직렬화되고,
 * core의 `detectedAt`(봉 인덱스)은 실거래 문맥에서 의미가 없다.
 */
export interface ConfluenceSnapshot {
    /** 계산에 쓴 봉 타임프레임 ('15Min' | '30Min' | '1Hour'). */
    timeframe: string;
    /** 마지막 봉의 시각 (unix seconds). */
    barTime: number;
    /** 마지막 봉의 종가. */
    close: number;
    /** SMA(50). 봉이 50개 미만이면 null. */
    ma50: number | null;
    /** 현재 활성 bullish 시그널 타입 (중복 제거·정렬). */
    bullish: string[];
    /** 현재 활성 bearish 시그널 타입 (중복 제거·정렬). */
    bearish: string[];
    /** 직전 봉 대비 신규로 켜진 bullish 타입. */
    freshBullish: string[];
    /** 직전 봉 대비 신규로 켜진 bearish 타입. */
    freshBearish: string[];
    /** bullish >= CONFLUENCE_MIN && freshBullish >= 1 && close > ma50 */
    entryTrigger: boolean;
    /** bearish >= CONFLUENCE_MIN && freshBearish >= 1 && close < ma50 */
    exitTrigger: boolean;
}

/**
 * 스냅샷을 0~100 신호 점수로 환산한다.
 *
 * 연속 점수(20..80)는 강세/약세 타입 수의 축소 비율에서 나오고, 백테스트 룰이 정확히
 * 성립한 경우에만 92 이상 / 8 이하로 스냅된다. 최상위 가중치를 갖더라도 단독으로는
 * 매수 임계(70)를 넘기지 못하도록 설계된 값이다.
 *
 * `null`은 50을 반환한다. 다른 축의 `null → 50` 관례와 형태를 맞춘 것이며, 실제로는
 * `scoreSignals`가 가중치를 0으로 떨어뜨려 이 값이 평균에 들어가지 않는다.
 */
export function scoreConfluence(snapshot: ConfluenceSnapshot | null): number {
    if (!snapshot) return 50;

    const bull = snapshot.bullish.length;
    const bear = snapshot.bearish.length;
    const directional = bull + bear;

    let base = 50;
    if (directional > 0) {
        const net = (bull - bear) / (directional + CONFLUENCE_SHRINK);
        base = 50 + net * CONFLUENCE_SPAN;
    }

    if (snapshot.entryTrigger) base = Math.max(base, CONFLUENCE_TRIGGER_SCORE);
    if (snapshot.exitTrigger) base = Math.min(base, CONFLUENCE_EXIT_SCORE);

    return clamp(Math.round(base), 0, 100);
}

/**
 * 보유 포지션 재평가용 하락 컨플루언스 청산 신호.
 *
 * 점수와 달리 이쪽은 트리거만 본다 — 약세 신호가 몇 개 켜졌다는 사실만으로 보유분을
 * 팔면 정상적인 눌림에도 매번 청산하게 된다. 백테스트 룰이 온전히 뒤집힌 경우만 센다.
 */
export function isConfluenceExit(snapshot: ConfluenceSnapshot | null): boolean {
    return snapshot?.exitTrigger === true;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}
