import {
    submitNewsCardAnalysis,
    pollNewsCardAnalysis,
    type NewsItem,
    type NewsCardAnalysis,
    type EnrichedNewsItem,
} from '@y0ngha/siglens-core';
import { pollUntilDone } from './poll-until-done.js';
import type { NewsCardStore } from './types.js';

export const NEWS_ENRICH_LIMIT = 20;
export const CARD_MODEL_ID = 'gemini-2.5-flash-lite';
// Vercel maxDuration 보호: 연속 N건 실패 시 enrich 루프 조기 종료.
// 워커 전반 장애(LLM down/rate-limit storm) 시 20×150s 누적을 막는다.
export const ENRICH_CONSECUTIVE_FAILURE_LIMIT = 3;

export async function enrichNewsCards(
    store: NewsCardStore,
    symbol: string,
    news: NewsItem[],
): Promise<EnrichedNewsItem[]> {
    const capped = news.slice(0, NEWS_ENRICH_LIMIT);
    const cached = await store.getCards(capped.map((n) => n.id));

    const fresh: { item: NewsItem; card: NewsCardAnalysis }[] = [];
    let consecutiveFailures = 0;
    for (const item of capped) {
        if (cached.has(item.id)) continue;
        if (consecutiveFailures >= ENRICH_CONSECUTIVE_FAILURE_LIMIT) {
            console.warn('[enrich-news-cards] short-circuit', {
                symbol,
                consecutiveFailures,
            });
            break;
        }
        try {
            const sub = await submitNewsCardAnalysis({ item, thinkingBudget: 0 });
            if (sub.status !== 'submitted' || !('jobId' in sub)) {
                consecutiveFailures += 1;
                continue;
            }
            const polled = await pollUntilDone(pollNewsCardAnalysis, sub.jobId);
            if ('error' in polled) {
                console.warn('[enrich-news-cards] card failed', {
                    symbol,
                    id: item.id,
                    error: polled.error,
                });
                consecutiveFailures += 1;
                continue;
            }
            fresh.push({ item, card: polled.result as NewsCardAnalysis });
            consecutiveFailures = 0;
        } catch (err) {
            console.warn('[enrich-news-cards] card threw', { symbol, id: item.id, err });
            consecutiveFailures += 1;
        }
    }

    if (fresh.length > 0) {
        try {
            await store.upsertCards(
                fresh.map((f) => ({
                    newsId: f.item.id,
                    symbol,
                    card: f.card,
                    modelId: CARD_MODEL_ID,
                })),
            );
        } catch (err) {
            console.error('[enrich-news-cards] persist failed (proceeding with in-memory)', err);
        }
        for (const f of fresh) cached.set(f.item.id, f.card);
    }

    return capped.filter((n) => cached.has(n.id)).map((n) => ({ ...n, card: cached.get(n.id)! }));
}
