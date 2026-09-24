import type { Db } from '../../lib/db/index.js';
import { getNewsCards, getRecentAnalysisResults, upsertNewsCards } from '../../lib/db/queries.js';
import type { NewsCardStore, PriorAnalysisStore } from '../../lib/analysis/types.js';

/**
 * 분석 러너를 크론에서 부를 때 필요한 I/O 조각. 종전 시간당 분석 크론(`_run-analysis-cron.ts`)에
 * 있던 것을 AI 리뷰 크론이 쓰도록 옮겼다 — 동작은 같다.
 */

/**
 * BYOK 모드에서 modelId에 맞는 서버 API 키를 반환한다.
 *
 * 지원 프리픽스: claude → ANTHROPIC_API_KEY, gpt → OPENAI_API_KEY,
 * gemini → GEMINI_API_KEY, deepseek → DEEPSEEK_API_KEY.
 * 키가 필요한데 환경변수가 비어 있으면 경고를 남긴다 — 조용히 undefined를 흘리면 매 실행이
 * 불투명한 BYOK 오류가 된다.
 */
export function resolveApiKey(modelId: string): string | undefined {
    const envKey = modelId.startsWith('claude')
        ? 'ANTHROPIC_API_KEY'
        : modelId.startsWith('gpt')
          ? 'OPENAI_API_KEY'
          : modelId.startsWith('gemini')
            ? 'GEMINI_API_KEY'
            : modelId.startsWith('deepseek')
              ? 'DEEPSEEK_API_KEY'
              : null;
    // 알 수 없는 프리픽스 — BYOK 키 없음. core가 key_error를 반환한다.
    if (envKey === null) return undefined;
    const value = process.env[envKey];
    if (!value) {
        console.warn(`[resolveApiKey] ${envKey} is not set — BYOK calls for ${modelId} will fail`);
    }
    return value;
}

/**
 * `promise`가 `ms` 안에 끝나지 않으면 던진다. 인플라이트 작업을 **취소하지는 못한다** — 그건 각
 * 러너의 AbortSignal 몫이고, 이건 실행이 영영 반환하지 않는 것만 막는다.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    if (!Number.isFinite(ms) || ms <= 0) {
        // 버리는 promise에도 핸들러를 붙인다 — 나중에 reject되면 미처리 rejection이 되어
        // Node 22 기본 설정에서 프로세스가 죽는다(인프로세스 크론이 통째로 멈춘다).
        void promise.catch(() => {});
        return Promise.reject(new Error('run_deadline'));
    }
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('run_deadline')), ms);
        }),
    ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** 뉴스 카드 캐시 저장소 — `analysis` 레이어가 db를 모르게 하는 포트의 구현. */
export function newsCardStore(db: Db): NewsCardStore {
    return {
        getCards: (ids) => getNewsCards(db, ids),
        upsertCards: (rows) => upsertNewsCards(db, [...rows]),
    };
}

/** 기술 분석의 과거 분석 맥락 저장소(prior-analysis). */
export function priorAnalysisStore(db: Db): PriorAnalysisStore {
    return {
        getRecent: (p) =>
            getRecentAnalysisResults(db, {
                symbol: p.symbol,
                type: 'technical',
                timeframe: p.timeframe,
                limit: p.limit,
                since: p.since,
            }),
    };
}
