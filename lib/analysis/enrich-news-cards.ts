import {
    submitNewsCardAnalysis,
    pollNewsCardAnalysis,
    type NewsItem,
    type NewsCardAnalysis,
    type EnrichedNewsItem,
} from '@y0ngha/siglens-core';
import type { Db } from '../db/index.js';
import { getNewsCards, upsertNewsCards } from '../db/queries.js';
import { pollUntilDone } from './poll-until-done.js';

export const NEWS_ENRICH_LIMIT = 20;
export const CARD_MODEL_ID = 'gemini-2.5-flash-lite';

export async function enrichNewsCards(
    db: Db,
    symbol: string,
    news: NewsItem[],
): Promise<EnrichedNewsItem[]> {
    const capped = news.slice(0, NEWS_ENRICH_LIMIT);
    const cached = await getNewsCards(
        db,
        capped.map((n) => n.id),
    );

    const fresh: { item: NewsItem; card: NewsCardAnalysis }[] = [];
    for (const item of capped) {
        if (cached.has(item.id)) continue;
        try {
            const sub = await submitNewsCardAnalysis({ item, thinkingBudget: 0 });
            if (sub.status !== 'submitted' || !('jobId' in sub)) continue;
            const polled = await pollUntilDone(pollNewsCardAnalysis, sub.jobId);
            if ('error' in polled) {
                console.warn('[enrich-news-cards] card failed', {
                    symbol,
                    id: item.id,
                    error: polled.error,
                });
                continue;
            }
            fresh.push({ item, card: polled.result as NewsCardAnalysis });
        } catch (err) {
            console.warn('[enrich-news-cards] card threw', { symbol, id: item.id, err });
        }
    }

    if (fresh.length > 0) {
        try {
            await upsertNewsCards(
                db,
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
