import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NewsItem, NewsCardAnalysis } from '@y0ngha/siglens-core';
import type { NewsCardStore } from '../types';

const mockRun = vi.fn();
vi.mock('@y0ngha/siglens-core', () => ({
    runNewsCardAnalysis: (...args: unknown[]) => mockRun(...args),
}));

const mockGetCards = vi.fn();
const mockUpsertCards = vi.fn();
const fakeStore: NewsCardStore = {
    getCards: (...args) => mockGetCards(...args),
    upsertCards: (...args) => mockUpsertCards(...args),
};

function makeNews(id: string, symbol = 'NVDA'): NewsItem {
    return {
        id,
        symbol,
        source: 'site',
        url: `https://x/${id}`,
        publishedAt: '2026-06-15T00:00:00Z',
        titleEn: `title ${id}`,
        bodyEn: 'body',
    };
}

const card = (s: string): NewsCardAnalysis => ({
    titleKo: s,
    bodyKo: null,
    summaryKo: s,
    sentiment: 'neutral',
    category: 'other',
    priceImpact: 'low',
});

describe('enrichNewsCards', () => {
    beforeEach(() => {
        mockRun.mockReset();
        mockGetCards.mockReset();
        mockUpsertCards.mockReset();
        mockUpsertCards.mockResolvedValue(undefined);
    });

    it('happy: 신규 5건 → run 5회 → upsert 1회 → EnrichedNewsItem 5건', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        mockRun.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = [1, 2, 3, 4, 5].map((i) => makeNews(`n${i}`));
        const result = await enrichNewsCards(fakeStore, 'NVDA', news, { deadlineMs: Infinity });
        expect(mockRun).toHaveBeenCalledTimes(5);
        expect(mockUpsertCards).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(5);
        expect(result.every((r) => r.card.summaryKo === 'ok')).toBe(true);
    });

    it('이중 과금 방지: 전부 캐시 hit → run 호출 0회', async () => {
        const cached = new Map([
            ['n1', card('c1')],
            ['n2', card('c2')],
        ]);
        mockGetCards.mockResolvedValueOnce(cached);
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeStore, 'NVDA', [makeNews('n1'), makeNews('n2')], {
            deadlineMs: Infinity,
        });
        expect(mockRun).toHaveBeenCalledTimes(0);
        expect(mockUpsertCards).not.toHaveBeenCalled();
        expect(result).toHaveLength(2);
    });

    it('부분 hit: 7 캐시 + 3 신규 → run 3회, 결과 10건', async () => {
        const cached = new Map(
            Array.from({ length: 7 }, (_, i) => [`n${i}`, card(`c${i}`)] as const),
        );
        mockGetCards.mockResolvedValueOnce(cached);
        mockRun.mockImplementation(async () => ({ status: 'done', result: card('new') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = Array.from({ length: 10 }, (_, i) => makeNews(`n${i}`));
        const result = await enrichNewsCards(fakeStore, 'NVDA', news, { deadlineMs: Infinity });
        expect(mockRun).toHaveBeenCalledTimes(3);
        expect(result).toHaveLength(10);
    });

    it('caps input at 10 articles', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        mockRun.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = Array.from({ length: 100 }, (_, i) => makeNews(`n${i}`));
        await enrichNewsCards(fakeStore, 'NVDA', news, { deadlineMs: Infinity });
        const ids = mockGetCards.mock.calls[0][0] as string[];
        expect(ids).toHaveLength(10);
        expect(mockRun).toHaveBeenCalledTimes(10);
        const rows = mockUpsertCards.mock.calls[0][0] as unknown[];
        expect(rows).toHaveLength(10);
    });

    it('never exceeds concurrency 3', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        const news = Array.from({ length: 10 }, (_, i) => makeNews(`n${i}`));
        // Deterministic: each run blocks on a per-id gate; we release them in order
        // only after observing peak concurrency.
        const resolvers: Record<string, () => void> = {};
        const gates: Record<string, Promise<void>> = {};
        for (const item of news) {
            gates[item.id] = new Promise<void>((resolve) => {
                resolvers[item.id] = resolve;
            });
        }
        let active = 0;
        let maxActive = 0;
        mockRun.mockImplementation(async (opts: { item: NewsItem }) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await gates[opts.item.id];
            active -= 1;
            return { status: 'done', result: card('ok') };
        });

        const { enrichNewsCards } = await import('../enrich-news-cards');
        const promise = enrichNewsCards(fakeStore, 'NVDA', news, { deadlineMs: Infinity });
        // Drain microtasks so the pool spins up its workers and reaches peak concurrency,
        // then release the gates one at a time.
        for (const item of news) {
            await Promise.resolve();
            await Promise.resolve();
            resolvers[item.id]();
        }
        await promise;
        expect(maxActive).toBe(3);
    });

    it('does not run new cards after the deadline', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = Array.from({ length: 10 }, (_, i) => makeNews(`n${i}`));
        const result = await enrichNewsCards(fakeStore, 'NVDA', news, {
            deadlineMs: Date.now() - 1,
        });
        expect(mockRun).not.toHaveBeenCalled();
        expect(result).toEqual([]);
    });

    it('returns cached cards even when deadline already passed (no new runs)', async () => {
        const cached = new Map([['n0', card('c0')]]);
        mockGetCards.mockResolvedValueOnce(cached);
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = [makeNews('n0'), makeNews('n1')];
        const result = await enrichNewsCards(fakeStore, 'NVDA', news, {
            deadlineMs: Date.now() - 1,
        });
        expect(mockRun).not.toHaveBeenCalled();
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('n0');
    });

    it('stops new work after six total failures', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        mockRun.mockRejectedValue(new Error('worker down'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const tenNews = Array.from({ length: 10 }, (_, i) => makeNews(`n${i}`));
        const result = await enrichNewsCards(fakeStore, 'NVDA', tenNews, { deadlineMs: Infinity });
        // Total-failure limit is 6; with concurrency 3 a couple already-in-flight
        // workers may finish, but new work stops well short of all 10.
        // 실패 상한이 6이므로 최소 6건은 제출되어야 하고(너무 일찍 멈추지 않음),
        // concurrency 3의 in-flight 슬랙으로 최대 8건까지만 허용된다.
        expect(mockRun.mock.calls.length).toBeGreaterThanOrEqual(6);
        expect(mockRun.mock.calls.length).toBeLessThanOrEqual(8);
        expect(result).toEqual([]);
        warnSpy.mockRestore();
    });

    it('부분 실패: 신규 5건 중 2건 throw → 성공 3건만 enrich/persist', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        let i = 0;
        mockRun.mockImplementation(async () => {
            i += 1;
            if (i === 2 || i === 4) throw new Error('rate-limit');
            return { status: 'done', result: card(`ok${i}`) };
        });
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = [1, 2, 3, 4, 5].map((n) => makeNews(`n${n}`));
        const result = await enrichNewsCards(fakeStore, 'NVDA', news, { deadlineMs: Infinity });
        expect(result).toHaveLength(3);
        const persistedRows = mockUpsertCards.mock.calls[0][0] as { newsId: string }[];
        expect(persistedRows).toHaveLength(3);
    });

    it('전부 실패: 신규 5건 모두 throw → 빈 배열 반환, upsert 호출 0회', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        mockRun.mockRejectedValue(new Error('down'));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(
            fakeStore,
            'NVDA',
            [1, 2, 3, 4, 5].map((n) => makeNews(`n${n}`)),
            { deadlineMs: Infinity },
        );
        expect(result).toEqual([]);
        expect(mockUpsertCards).not.toHaveBeenCalled();
    });

    it('runNewsCardAnalysis가 throw 시 해당 건 드롭, 나머지 진행', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        let i = 0;
        mockRun.mockImplementation(async () => {
            i += 1;
            if (i === 1) throw new Error('rejected');
            return { status: 'done', result: card('ok') };
        });
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeStore, 'NVDA', [makeNews('n1'), makeNews('n2')], {
            deadlineMs: Infinity,
        });
        expect(result).toHaveLength(1);
    });

    it('upsertCards가 throw 시에도 메모리 카드로 결과 반환 (persist 실패 완화책)', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        mockRun.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        mockUpsertCards.mockRejectedValueOnce(new Error('neon down'));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeStore, 'NVDA', [makeNews('n1'), makeNews('n2')], {
            deadlineMs: Infinity,
        });
        expect(result).toHaveLength(2);
        // 핵심 invariant: persist 실패에도 메모리 카드가 실제로 결과에 실려야 함
        expect(result[0].card.summaryKo).toBe('ok');
        expect(result[1].card.summaryKo).toBe('ok');
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    it('run 호출 시 thinkingBudget: 0 전달', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        mockRun.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        await enrichNewsCards(fakeStore, 'NVDA', [makeNews('n1')], { deadlineMs: Infinity });
        expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ thinkingBudget: 0 }));
    });

    it('빈 news 입력 → 빈 배열, run/upsert 모두 호출 없음', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeStore, 'NVDA', [], { deadlineMs: Infinity });
        expect(result).toEqual([]);
        expect(mockRun).not.toHaveBeenCalled();
        expect(mockUpsertCards).not.toHaveBeenCalled();
    });

    it('options omitted → defaults to no deadline (Infinity)', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        mockRun.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeStore, 'NVDA', [makeNews('n1')]);
        expect(result).toHaveLength(1);
        expect(mockRun).toHaveBeenCalledTimes(1);
    });

    // S8 / B1 회귀 방지: resolve-with-failure-status 경로
    it('S8: resolve가 non-done 상태이면 해당 건 드롭 + failures 카운트 + upsertCards 미호출', async () => {
        // runNewsCardAnalysis가 done이 아닌 상태로 resolve하는 경우(현재 정의상 없지만 방어적 검증).
        mockGetCards.mockResolvedValueOnce(new Map());
        mockRun.mockResolvedValue({ status: 'key_error', error: 'no key' });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeStore, 'NVDA', [makeNews('n1')], {
            deadlineMs: Infinity,
        });
        // 드롭되어야 함: 결과 빈 배열, upsert 미호출
        expect(result).toEqual([]);
        expect(mockUpsertCards).not.toHaveBeenCalled();
        // 경고 로그 발생 확인
        expect(warnSpy).toHaveBeenCalledWith(
            '[enrich-news-cards] unexpected non-done status',
            expect.objectContaining({ status: 'key_error' }),
        );
        warnSpy.mockRestore();
    });

    it('S8: resolve-failure 6회 누적 시 ENRICH_TOTAL_FAILURE_LIMIT 도달, 추가 작업 없음', async () => {
        // 10건 중 6건이 non-done resolve → FAILURE_LIMIT 도달로 남은 4건 미처리
        mockGetCards.mockResolvedValueOnce(new Map());
        mockRun.mockResolvedValue({ status: 'error', error: 'provider down' });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { enrichNewsCards, ENRICH_TOTAL_FAILURE_LIMIT, NEWS_ENRICH_CONCURRENCY } =
            await import('../enrich-news-cards');
        const tenNews = Array.from({ length: 10 }, (_, i) => makeNews(`n${i}`));
        const result = await enrichNewsCards(fakeStore, 'NVDA', tenNews, { deadlineMs: Infinity });
        // 실패 상한(6)에 의해 멈춰야 함. concurrency 3의 in-flight 슬랙으로 최대 8까지 허용.
        expect(mockRun.mock.calls.length).toBeGreaterThanOrEqual(ENRICH_TOTAL_FAILURE_LIMIT);
        expect(mockRun.mock.calls.length).toBeLessThanOrEqual(
            ENRICH_TOTAL_FAILURE_LIMIT + NEWS_ENRICH_CONCURRENCY - 1,
        );
        expect(result).toEqual([]);
        expect(mockUpsertCards).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });
});
