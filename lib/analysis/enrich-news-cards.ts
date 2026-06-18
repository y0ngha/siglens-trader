import {
    submitNewsCardAnalysis,
    pollNewsCardAnalysis,
    type NewsItem,
    type NewsCardAnalysis,
    type EnrichedNewsItem,
} from '@y0ngha/siglens-core';
import { pollUntilDone } from './poll-until-done.js';
import type { NewsCardStore } from './types.js';

// 최신 10건만 enrich(과거 20건에서 축소). cron maxDuration 안에서 처리 가능하도록.
export const NEWS_ENRICH_LIMIT = 10;
// 고정 크기 워커 풀: 동시 LLM 작업 상한.
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

    // 한 기사의 enrich 시도. 성공 시 카드, 실패(throw/error/non-submitted) 시 null.
    // symbol을 클로저로 참조하므로 enrichNewsCards 내부에 중첩한다.
    async function generateCard(item: NewsItem): Promise<NewsCardAnalysis | null> {
        try {
            const submission = await submitNewsCardAnalysis({ item, thinkingBudget: 0 });
            if (submission.status !== 'submitted' || !('jobId' in submission)) return null;
            const polled = await pollUntilDone(pollNewsCardAnalysis, submission.jobId);
            if ('error' in polled) {
                console.warn('[enrich-news-cards] card failed', {
                    symbol,
                    id: item.id,
                    error: polled.error,
                });
                return null;
            }
            return polled.result as NewsCardAnalysis;
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
