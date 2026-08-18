import type { ModelId, Tier, Timeframe, NewsCardAnalysis } from '@y0ngha/siglens-core';

export type AnalysisType = 'technical' | 'news' | 'options' | 'fundamental';

/**
 * 이번 심볼에 줄 AbortSignal. **실행 마감 외에 별도 상한을 두지 않는다.**
 *
 * 종전에는 심볼당 150초 상한이 따로 있었고, 그게 추론 ON인 축에서 타임아웃이 아니라
 * 실패 그 자체였다. 2026-08-17 프로덕션 로그:
 *
 *   Response time:  58192ms  finish_reason: stop        ← 정상 완료, 저장됨
 *   Response time: 147395ms  finish_reason: undefined   ← 실패
 *   Response time: 148596ms  finish_reason: undefined   ← 실패
 *
 * 실패가 147.4~148.6초에 몰렸다 — 프로바이더가 끝낸 값이 아니라 우리가 끊은 값이다
 * (봉 조회 오버헤드를 뺀 150초). DeepSeek 스트림은 중단 시 예외 대신 `finish_reason` 없는
 * 응답을 돌려주고(같은 8시간 로그에 `AbortError` 0건), core는 그걸 retryable로 분류해
 * 재시도하려다 예산(240초)에 걸려 `AI_SERVER_UNSTABLE`을 던진다. 프로바이더 장애로
 * 보이던 것이 전부 자기 타임아웃이었다.
 *
 * 상한을 다시 "적당한 큰 값"으로 고쳐 잡지 않는 이유: 그 값이 얼마여야 하는지 알 방법이
 * 없다. 실측은 58초 성공과 강제중단뿐이라 진짜 필요한 시간의 분포를 모른다. 그래서 예산을
 * **하나로** 줄인다 — 실행 마감(`analysisDeadlineMs`, cron 시작 + 1200초). 그 마감은
 * `_run-analysis-cron.ts`의 `withDeadline`이 런 레벨에서도 강제하므로, 심볼 하나가
 * 매달려도 런은 반드시 끝나고 이 signal이 인플라이트 호출까지 취소한다.
 *
 * 마감이 없으면(테스트/수동 호출) signal도 없다 — core의 자체 예산(DeepSeek 어댑터 1시간,
 * 재시도 wall-clock 240초)만 남는다.
 */
export function symbolSignal(deadlineMs: number | undefined): AbortSignal | undefined {
    if (deadlineMs === undefined || !Number.isFinite(deadlineMs)) return undefined;
    // 이미 지났어도 0을 주지 않는다 — 0은 즉시 중단이라 호출이 무의미한 실패로 기록된다.
    // 마감 판정은 호출부(`withDeadline`)가 한다.
    return AbortSignal.timeout(Math.max(1, deadlineMs - Date.now()));
}

/**
 * Convert any core error value to a plain human-readable string.
 *
 * Priority order:
 * 1. plain string → returned as-is
 * 2. Error instance → `.message`
 * 3. object with `.message: string` (core structured errors: AnalysisLimitError,
 *    TierTimeframeAccessError, etc.) → `.message`
 * 4. anything else → JSON.stringify, falling back to String() for
 *    non-serialisable values (undefined, Symbol, functions).
 *
 * `JSON.stringify` returns `undefined` for those edge cases — `?? String(e)`
 * makes the return type reliably `string` rather than `string | undefined`.
 */
export function toErrStr(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
        return (e as { message: string }).message;
    }
    return JSON.stringify(e) ?? String(e);
}

/**
 * Tier used for every analysis submit/poll against siglens-core.
 *
 * siglens-core gates timeframes (free = 1Day only) and strips action-price
 * fields (entry/stoploss/target/confidence) from analysis results for the
 * free tier via `filterAnalysisResult`. siglens-trader is a private, single-user
 * trading tool that needs the full-fidelity signal set at intraday timeframes
 * (15Min/30Min/1Hour), so it always identifies as `pro` — the tier gates are a
 * product-monetization concern for the public siglens.io site, not for this
 * cron. When no tier context is supplied, core defaults to `free`, which would
 * both block the 1Hour timeframe and gut the trading signals.
 */
export const ANALYSIS_TIER: Tier = 'pro';

/**
 * 상세 분석(reasoning) 기본값. 정책이 없는 분석 타입은 이 값을 따른다 — 새 분석이 추가되면
 * 품질 우선(ON)으로 시작하고, 지연이 문제가 될 때 아래 표에 명시적으로 내린다.
 */
export const DEFAULT_ANALYSIS_REASONING = true;

/**
 * 분석 타입별 상세 분석(reasoning) 정책.
 *
 * 분석이 얼마나 자주 돌아야 하는지가 추론을 감당할 수 있는지를 결정한다. 실측(2026-08-10,
 * deepseek-v4-flash, 30Min):
 *
 *   추론 ON인 technical은 심볼당 출력이 22k~37k 토큰까지 늘어나 첫 호출이
 *   `finish_reason: undefined`로 잘리고(148초 낭비), 재시도가 269초를 더 써서
 *   심볼당 약 7분이 걸렸다. 4종목이면 한 패스에 ~28분 — cron의 690초 컷오프를 넘고
 *   30분 구간 안에 끝나지 못해 일부 종목이 매 구간 신호를 받지 못했다.
 *
 * **technical은 2026-08-17에 다시 켰다.** 위 측정의 결론("주기를 지키지 못하면 신호가
 * 사라진다")이 과장이었다. 실제로 무슨 일이 나는지 다시 따져보면:
 *
 *   패스가 창(30분)을 넘기면, 마지막 종목의 분석이 다음 창에 저장되어 그 창의 재실행을
 *   소비한다. 즉 **그 종목만** 갱신 주기가 30분 → 60분이 된다. 앞선 종목들은 창 안에
 *   저장되므로 30분을 유지하고, 다음 패스에서는 스킵된 종목만큼 시간이 남아 순번이
 *   앞당겨진다 — 특정 종목이 계속 밀리지 않는 자기 균형 구조다.
 *
 *   그리고 60분은 30Min 타임프레임의 신선도 한도(90분) 안이다. `stale_analysis`에 걸리지
 *   않으므로 매매는 그대로 돈다. execute는 10분마다 최신 분석을 다시 읽으므로 늦게 도착한
 *   신호도 최대 10분 안에 반영된다.
 *
 * **위 측정의 "truncation"은 truncation이 아니었다 (2026-08-17 확인).** 프로덕션 로그의
 * 실패는 전부 147.4~148.6초에서 `finish_reason: undefined`로 끝났다 — 토큰이 넘쳐 잘린
 * 것이 아니라 트레이더 자신의 150초 `AbortSignal`이 끊은 것이다(같은 8시간 로그에
 * `AbortError` 0건, 58초에 끝난 호출은 `finish_reason: stop`으로 정상 저장됐다).
 * DeepSeek 스트림은 중단 시 예외 대신 finish_reason 없는 응답을 돌려주고, core는 그것을
 * retryable로 분류해 재시도하려다 예산(240초)에 걸려 `AI_SERVER_UNSTABLE`을 던진다.
 * 그래서 심볼당 상한을 아예 없앴다({@link symbolSignal}) — 추론을 켜는 결정과 그 추론이
 * 끝날 시간을 주는 결정은 하나여야 하고, 필요한 시간을 모르는 채 정한 숫자는 그 자체가
 * 실패 원인이 된다. 남은 예산은 실행 마감 하나다.
 *
 * options도 2026-08-17에 켰다. 옵션 체인 요약은 만기별 OI/IV 집계라 장문 추론이 결론을
 * 크게 바꾸지 않는다고 봤지만, 축을 하나만 끄고 두면 "왜 이 축만 다른가"를 매번 설명해야
 * 하고 실제로 판단 근거의 두께가 얇아진다. 켜는 비용은 시간뿐이고(심볼 상한이 사라져
 * 그 시간이 실패로 바뀌지 않는다), 옵션 cron은 15분마다 돌되 케이던스 창이 잉여 틱을 접는다.
 */
export const ANALYSIS_REASONING: Readonly<Record<string, boolean>> = {
    technical: true,
    options: true,
    news: true,
    fundamental: true,
    congress: true,
};

/** 해당 분석 타입의 reasoning 설정. 정책이 없으면 {@link DEFAULT_ANALYSIS_REASONING}. */
export function getAnalysisReasoning(analysisType: string): boolean {
    return ANALYSIS_REASONING[analysisType] ?? DEFAULT_ANALYSIS_REASONING;
}

// Port: db 의존을 analysis 레이어 밖으로 분리한다. 구현체는 api/cron 레이어가 주입.
export interface NewsCardStore {
    getCards(newsIds: string[]): Promise<Map<string, NewsCardAnalysis>>;
    upsertCards(
        rows: ReadonlyArray<{
            newsId: string;
            symbol: string;
            card: NewsCardAnalysis;
            modelId: string;
        }>,
    ): Promise<void>;
}

export interface RunAnalysisOptions {
    symbol: string;
    companyName: string;
    modelId: ModelId;
    userApiKey?: string;
    timeframe?: Timeframe;
    /** news enrich에 필요. factory가 항상 주입. */
    cardStore?: NewsCardStore;
    /**
     * 상세 분석(deep-thinking reasoning) 토글. 지정하지 않으면 항상 ON으로 취급한다.
     * siglens-trader에는 상세분석 스위치 UI가 없으므로 cron이 항상 `true`로 주입하며,
     * 향후 대시보드에 스위치가 추가되면 이 필드로 값을 흘려보내면 된다(기본값 ON).
     */
    reasoning?: boolean;
    /**
     * 새 LLM 작업을 시작하지 않을 절대 시각(epoch ms). cron 시작 + 690s.
     * 이 시각 이후엔 news enrich/aggregate submit을 시작하지 않고 캐시/완료분만 반환.
     */
    deadlineMs?: number;
}

export interface AnalysisRunResult {
    status: 'done' | 'cached' | 'error' | 'skipped';
    result?: unknown;
    error?: string;
}
