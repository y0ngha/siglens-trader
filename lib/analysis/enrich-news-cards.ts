import {
    runNewsCardAnalysis,
    type NewsItem,
    type NewsCardAnalysis,
    type EnrichedNewsItem,
} from '@y0ngha/siglens-core';
import type { NewsCardStore } from './types.js';

// 최신 10건만 enrich(과거 20건에서 축소). cron maxDuration 안에서 처리 가능하도록.
export const NEWS_ENRICH_LIMIT = 10;
/** 카드 1건의 응답 대기 상한. */
const CARD_TIMEOUT_MS = 30_000;
// 고정 크기 워커 풀: **심볼당** 동시 LLM 작업 상한. 분석 cron이 심볼을 병렬로 돌리므로
// 프로세스 전체의 동시 호출은 이 값 × 심볼 수다(워치리스트 상한 5 → 최대 15).
export const NEWS_ENRICH_CONCURRENCY = 3;
// 풀 전반의 누적 실패 상한(성공해도 리셋되지 않는 합산 카운터). LLM down/rate-limit storm 시 조기 종료.
export const ENRICH_TOTAL_FAILURE_LIMIT = 6;
export const CARD_MODEL_ID = 'gemini-2.5-flash-lite';

export async function enrichNewsCards(
    store: NewsCardStore,
    symbol: string,
    news: NewsItem[],
    options: { deadlineMs?: number } = {},
): Promise<EnrichedNewsItem[]> {
    const deadlineMs = options.deadlineMs ?? Number.POSITIVE_INFINITY;
    const capped = news.slice(0, NEWS_ENRICH_LIMIT);
    const cached = await store.getCards(capped.map((item) => item.id));
    const missing = capped.filter((item) => !cached.has(item.id));

    const fresh: Array<{ item: NewsItem; card: NewsCardAnalysis }> = [];
    let nextIndex = 0;
    let failures = 0;

    /**
     * 한 기사의 enrich 시도.
     *
     * `runNewsCardAnalysis`는 현재 항상 `{ status: 'done', result }` 또는 throw다
     * (tier/usage 게이트가 없으므로 non-done resolve-failure는 정의상 없음).
     * status를 명시적으로 검사하는 이유: 향후 core union이 확장될 경우
     * 조용히 undefined를 persist하는 대신 이 함수가 null을 반환해 failures를
     * 올바르게 카운트하도록 방어한다.
     *
     * symbol을 클로저로 참조하므로 enrichNewsCards 내부에 중첩한다.
     */
    async function generateCard(item: NewsItem): Promise<NewsCardAnalysis | null> {
        // 카드 하나의 상한은 **실행 마감이 아니라** 카드 모델의 현실적인 응답 시간이다.
        // 남은 마감(최대 20분)을 그대로 주면 멈춘 카드 하나가 그 심볼의 news 예산을 다
        // 태우고, 워커 3개가 모두 걸리면 정상인 나머지 기사까지 통째로 버려진다.
        // 카드 모델은 `thinkingBudget: 0`이라 30초면 충분하다.
        const remainingMs = Number.isFinite(deadlineMs)
            ? Math.max(1, deadlineMs - Date.now())
            : CARD_TIMEOUT_MS;
        const cardSignal = AbortSignal.timeout(Math.min(CARD_TIMEOUT_MS, remainingMs));
        try {
            const outcome = await runNewsCardAnalysis({
                item,
                thinkingBudget: 0,
                signal: cardSignal,
            });
            if (outcome.status !== 'done') {
                // 현재 정의상 도달 불가이지만, core가 새로운 상태를 추가할 경우를 대비한 방어 처리.
                console.warn('[enrich-news-cards] unexpected non-done status', {
                    symbol,
                    id: item.id,
                    status: outcome.status,
                });
                return null;
            }
            return outcome.result;
        } catch (error) {
            console.warn('[enrich-news-cards] card threw', { symbol, id: item.id, error });
            return null;
        }
    }

    // 워커는 공유 인덱스에서 다음 기사를 당겨온다. 한 기사 실패가 다른 기사를 무효화하지 않는다.
    // deadline을 지났거나 누적 실패가 상한이면 새 작업을 당기지 않는다.
    async function worker(): Promise<void> {
        while (Date.now() < deadlineMs && failures < ENRICH_TOTAL_FAILURE_LIMIT) {
            const index = nextIndex++;
            const item = missing[index];
            if (!item) return;
            const generated = await generateCard(item);
            if (generated === null) {
                failures += 1;
                continue;
            }
            fresh.push({ item, card: generated });
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(NEWS_ENRICH_CONCURRENCY, missing.length) }, () => worker()),
    );

    if (fresh.length > 0) {
        await store
            .upsertCards(
                fresh.map(({ item, card }) => ({
                    newsId: item.id,
                    symbol,
                    card,
                    modelId: CARD_MODEL_ID,
                })),
            )
            .catch((error) =>
                console.error(
                    '[enrich-news-cards] persist failed (proceeding with in-memory)',
                    error,
                ),
            );
        for (const { item, card } of fresh) cached.set(item.id, card);
    }

    return capped.flatMap((item) => {
        const card = cached.get(item.id);
        return card ? [{ ...item, card }] : [];
    });
}
