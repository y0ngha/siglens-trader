/**
 * 지표 컨플루언스 신호 — 순수 도메인.
 *
 * siglens 백테스트(2024.04–2026.04, 100케이스, 승률 70%)가 이긴 진입 룰을 점수화한다.
 * 룰 원문: 동시 활성 bullish 시그널 3종 이상 + 그중 1종 이상 신규 + 종가 > SMA(50).
 *
 * 이 파일은 I/O를 하지 않는다. 봉 조회와 siglens-core 지표 계산은
 * `lib/analysis/confluence.ts`가 담당하고, 여기에는 그 결과(스냅샷)만 들어온다.
 */

/**
 * 트리거에 필요한 **가중 계열 수**. 서로 다른 시그널 *타입* 수가 아니다.
 *
 * 백테스트 원본은 타입을 셌다. 그런데 core의 36종은 지표 14개에서 파생된다 — RSI 4종,
 * MACD 4종, 볼린저 6종. 타입을 세면 같은 종가 시계열의 변형을 독립 투표로 취급하게 되고,
 * 실측에서 3종 스냅샷 51건 중 8건(16%)이 실제로는 지표 2개였다
 * (`bollinger_lower_bounce + bollinger_percentb_oversold + rsi_oversold`). 같은 사람에게
 * 세 번 물어본 것을 세 명의 동의로 읽던 셈이다.
 *
 * 계열 단위 카운팅은 **조이는 방향으로만** 작동한다 — 타입 수 ≥ 계열 수이므로 통과하던
 * 조합 일부가 걸리고, 걸리지 않던 조합이 새로 통과하는 일은 없다.
 */
export const CONFLUENCE_MIN = 3;

/**
 * 중립 50 기준 연속 점수 폭 → 35..65.
 *
 * **30이었다가 15로 좁혔다.** 이 축은 트리거(92/8)가 2.8%, 연속 점수가 97.2%를 차지하는데
 * (실측 426스냅샷 중 진입 트리거 12회), 백테스트가 검증한 것은 트리거뿐이다. 연속 공식은
 * 검증 이력이 없는 자체 산식이다.
 *
 * 폭 30에서는 **지표 하나가 크로스한 것만으로 65점**이 나왔다(`net = 1/2`). 최상위 가중치
 * 13/36을 통과하면 종합 +5.4점 — 중립 50에서 매수 임계 70까지 거리의 27%를 오실레이터
 * 하나가 먹는다. 검증된 부분(트리거)은 그대로 두고 검증 안 된 구간만 줄이는 것이,
 * 가중치 자체를 내리는 것보다 정직하다.
 */
export const CONFLUENCE_SPAN = 15;

/**
 * `expected` phase 시그널의 표 가중치 (`confirmed`는 1).
 *
 * core는 확정 이벤트(`confirmed`, 28종)와 예상(`expected`, 8종)을 구분해 주는데 여태 둘을
 * 같은 무게로 셌다. `support_proximity_bullish`는 실측 강세 2위 빈도(스냅샷의 17.4%)인데
 * "가격이 지지선 근처에 있다"는 **상태**이지 사건이 아니다. MACD 크로스와 같은 한 표를
 * 줄 근거가 없다. 0으로 버리지 않는 것은 다이버전스처럼 실제 선행 정보인 것도 있어서다.
 */
export const CONFLUENCE_EXPECTED_WEIGHT = 0.5;

/**
 * 시그널 타입 → 지표 계열. 같은 지표에서 나온 시그널은 한 표로 합쳐진다.
 *
 * 미등록 타입(core가 디텍터를 추가한 경우)은 자기 자신을 계열로 삼는다 — 새 지표를
 * 조용히 0표로 만들지 않기 위해서다.
 */
const SIGNAL_FAMILY: Readonly<Record<string, string>> = {
    rsi_oversold: 'rsi',
    rsi_overbought: 'rsi',
    rsi_bullish_divergence: 'rsi',
    rsi_bearish_divergence: 'rsi',
    golden_cross: 'ma',
    death_cross: 'ma',
    macd_bullish_cross: 'macd',
    macd_bearish_cross: 'macd',
    macd_histogram_bullish_convergence: 'macd',
    macd_histogram_bearish_convergence: 'macd',
    bollinger_lower_bounce: 'bollinger',
    bollinger_upper_breakout: 'bollinger',
    bollinger_percentb_oversold: 'bollinger',
    bollinger_percentb_overbought: 'bollinger',
    bollinger_squeeze_bullish: 'bollinger',
    bollinger_squeeze_bearish: 'bollinger',
    supertrend_bullish_flip: 'supertrend',
    supertrend_bearish_flip: 'supertrend',
    parabolic_sar_flip: 'psar',
    parabolic_sar_bearish_flip: 'psar',
    ichimoku_cloud_breakout: 'ichimoku',
    ichimoku_cloud_breakdown: 'ichimoku',
    cci_bullish_cross: 'cci',
    cci_bearish_cross: 'cci',
    dmi_bullish_cross: 'dmi',
    dmi_bearish_cross: 'dmi',
    cmf_bullish_flip: 'cmf',
    cmf_bearish_flip: 'cmf',
    mfi_oversold_bounce: 'mfi',
    mfi_overbought_reversal: 'mfi',
    keltner_upper_breakout: 'keltner',
    keltner_lower_breakout: 'keltner',
    squeeze_momentum_bullish: 'squeeze',
    squeeze_momentum_bearish: 'squeeze',
    support_proximity_bullish: 'level',
    resistance_proximity_bearish: 'level',
};

/**
 * core의 `ExpectedSignalType` 8종. 확정 이벤트가 아니라 예상·상태다.
 *
 * 스냅샷이 타입 문자열만 담으므로 phase를 여기서 되살린다 — 두 union이 서로소라 타입
 * 이름만으로 판정이 성립하고, 덕분에 스냅샷 형태를 바꾸지 않아 **과거 감사 행도 그대로
 * 재채점된다.** core가 어느 타입을 expected로 옮기면 이 목록도 같이 고쳐야 한다.
 */
const EXPECTED_SIGNAL_TYPES: ReadonlySet<string> = new Set([
    'rsi_bullish_divergence',
    'rsi_bearish_divergence',
    'macd_histogram_bullish_convergence',
    'macd_histogram_bearish_convergence',
    'bollinger_squeeze_bullish',
    'bollinger_squeeze_bearish',
    'support_proximity_bullish',
    'resistance_proximity_bearish',
]);

/** 거래량에 근거한 계열. 거래량이 받쳐주지 않는 합류를 걸러내는 게이트에 쓰인다. */
export const VOLUME_FAMILIES: ReadonlySet<string> = new Set(['cmf', 'mfi']);

/** 이 시그널이 속한 지표 계열. 미등록이면 자기 자신. */
export function signalFamily(type: string): string {
    return SIGNAL_FAMILY[type] ?? type;
}

/**
 * 방향별 **가중 계열 수**. 한 계열에서 여러 시그널이 켜져도 그 계열의 **최고** 가중치
 * 하나만 센다 — 볼린저가 3종 켜져도 볼린저는 한 표다.
 *
 * 반환값이 정수가 아닐 수 있다(예: confirmed 2계열 + expected 1계열 = 2.5).
 */
export function confluenceFamilyWeight(
    types: readonly string[],
    expectedWeight: number = CONFLUENCE_EXPECTED_WEIGHT,
): number {
    const safeExpected =
        Number.isFinite(expectedWeight) && expectedWeight >= 0 ? Math.min(expectedWeight, 1) : 0;
    const best = new Map<string, number>();
    for (const type of types) {
        if (typeof type !== 'string') continue;
        const weight = EXPECTED_SIGNAL_TYPES.has(type) ? safeExpected : 1;
        const family = signalFamily(type);
        if (weight > (best.get(family) ?? 0)) best.set(family, weight);
    }
    let total = 0;
    for (const w of best.values()) total += w;
    return total;
}

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
    /**
     * 상위 시간축(기본 일봉) 추세. core의 `classifyTrend` 결과.
     *
     * `null`이면 게이트가 꺼졌거나 상위 봉 조회에 실패한 것이고, 그때는 정렬 조건을
     * 적용하지 않는다(fail-open) — 이 축은 추가 정보이지 매매의 전제조건이 아니다.
     * 구 스냅샷에는 이 필드가 없으므로 optional이다.
     */
    htfTrend?: 'uptrend' | 'downtrend' | 'sideways' | null;
    /**
     * 이 스냅샷을 만들 때 적용된 파라미터.
     *
     * 채점이 설정에 따라 달라지므로, 값만 남기면 과거 행이 **어떤 기준으로** 그 점수를
     * 받았는지 사후에 알 수 없다. 파라미터를 같이 적어 두면 설정을 바꾼 전후를 비교할 수
     * 있고, 그게 이 축을 튜닝할 유일한 근거다. 구 스냅샷에는 없으므로 optional이며
     * 없으면 모듈 기본값으로 채점된다.
     */
    params?: ConfluenceParams;
    /** 가중 계열 수 ≥ min && freshBullish ≥ 1 && close > ma50 && 상위추세 정렬 && 거래량 확인 */
    entryTrigger: boolean;
    /** 가중 계열 수 ≥ min && freshBearish ≥ 1 && close < ma50 (청산은 정렬·거래량을 요구하지 않는다) */
    exitTrigger: boolean;
}

/** 스냅샷 생성에 쓰인 튜너블. 전부 `config`에서 온다. */
export interface ConfluenceParams {
    /** 트리거에 필요한 가중 계열 수. */
    min: number;
    /** 연속 점수 폭. */
    span: number;
    /** `expected` phase 표 가중치. */
    expectedWeight: number;
    /** 상위 시간축 이름. 게이트가 꺼져 있으면 null. */
    htf: string | null;
    /** 강세 계열에 거래량 계열(cmf/mfi)이 최소 하나 있어야 진입 트리거가 서는가. */
    requireVolume: boolean;
}

/**
 * 스냅샷을 0~100 신호 점수로 환산한다.
 *
 * 연속 점수(35..65)는 강세/약세 **가중 계열 수**의 축소 비율에서 나오고, 진입/청산 룰이
 * 정확히 성립한 경우에만 92 이상 / 8 이하로 스냅된다. 최상위 가중치를 갖더라도 단독으로는
 * 매수 임계(70)를 넘기지 못하도록 설계된 값이다.
 *
 * 연속 구간과 트리거 스냅은 **신뢰도가 다르다.** 트리거는 백테스트가 검증한 룰이고,
 * 연속 구간은 그렇지 않다 — 그래서 폭이 30에서 15로 좁다(`CONFLUENCE_SPAN` 참고).
 *
 * `null`은 50을 반환한다. 다른 축의 `null → 50` 관례와 형태를 맞춘 것이며, 실제로는
 * `scoreSignals`가 가중치를 0으로 떨어뜨려 이 값이 평균에 들어가지 않는다.
 */
export function scoreConfluence(snapshot: ConfluenceSnapshot | null): number {
    if (!snapshot) return 50;

    // 스냅샷이 자기 파라미터를 들고 있으면 그걸 쓴다 — 과거 행을 그때의 기준으로 재현한다.
    const expectedWeight = snapshot.params?.expectedWeight ?? CONFLUENCE_EXPECTED_WEIGHT;
    // 음수 클램프는 바로 위 `expectedWeight`와 대칭이다. 정상 경로(`resolveParams`·API)는
    // 음수를 이미 막지만, 이 값은 JSONB에 실려 다니므로 손편집·손상 행이 들어올 수 있다.
    // 음수 span은 부호를 뒤집어 **강세 스냅샷을 약세 점수로** 만든다(측정: span −100 →
    // 순강세 스냅샷이 0점). 원칙 10(NaN 방어)이 막으려는 것과 같은 종류의 사고다.
    const rawSpan = snapshot.params?.span;
    const span =
        typeof rawSpan === 'number' && Number.isFinite(rawSpan) && rawSpan >= 0
            ? rawSpan
            : CONFLUENCE_SPAN;

    // 타입 수가 아니라 가중 계열 수를 센다 — 근거는 `CONFLUENCE_MIN`/`SIGNAL_FAMILY` 주석.
    const bull = confluenceFamilyWeight(snapshot.bullish, expectedWeight);
    const bear = confluenceFamilyWeight(snapshot.bearish, expectedWeight);
    const directional = bull + bear;

    let base = 50;
    if (directional > 0) {
        const net = (bull - bear) / (directional + CONFLUENCE_SHRINK);
        base = 50 + net * span;
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
