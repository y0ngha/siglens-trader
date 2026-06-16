import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NewsItem, NewsCardAnalysis } from '@y0ngha/siglens-core';

const mockSubmit = vi.fn();
const mockPoll = vi.fn();
vi.mock('@y0ngha/siglens-core', async () => {
    const actual =
        await vi.importActual<typeof import('@y0ngha/siglens-core')>('@y0ngha/siglens-core');
    return {
        ...actual,
        submitNewsCardAnalysis: (...args: unknown[]) => mockSubmit(...args),
        pollNewsCardAnalysis: (...args: unknown[]) => mockPoll(...args),
    };
});

const mockGetNewsCards = vi.fn();
const mockUpsertNewsCards = vi.fn();
vi.mock('../../db/queries.js', () => ({
    getNewsCards: (...args: unknown[]) => mockGetNewsCards(...args),
    upsertNewsCards: (...args: unknown[]) => mockUpsertNewsCards(...args),
}));

vi.mock('../poll-until-done.js', () => ({
    // pollUntilDone delegates straight to pollFn(jobId) so the mock controls outcome
    pollUntilDone: async (pollFn: (id: string) => Promise<unknown>, jobId: string) => {
        const r = (await pollFn(jobId)) as { status: string; result?: unknown; error?: string };
        if (r.status === 'done') return { result: r.result };
        return { error: r.error ?? 'unknown' };
    },
}));

const fakeDb = {} as never;

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
        mockSubmit.mockReset();
        mockPoll.mockReset();
        mockGetNewsCards.mockReset();
        mockUpsertNewsCards.mockReset();
    });

    it('happy: 신규 5건 → submit+poll 5회 → upsert 1회 → EnrichedNewsItem 5건', async () => {
        mockGetNewsCards.mockResolvedValueOnce(new Map());
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = [1, 2, 3, 4, 5].map((i) => makeNews(`n${i}`));
        const result = await enrichNewsCards(fakeDb, 'NVDA', news);
        expect(mockSubmit).toHaveBeenCalledTimes(5);
        expect(mockUpsertNewsCards).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(5);
        expect(result[0].card.summaryKo).toBe('ok');
    });

    it('이중 과금 방지: 전부 캐시 hit → submit 호출 0회', async () => {
        const cached = new Map([
            ['n1', card('c1')],
            ['n2', card('c2')],
        ]);
        mockGetNewsCards.mockResolvedValueOnce(cached);
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeDb, 'NVDA', [makeNews('n1'), makeNews('n2')]);
        expect(mockSubmit).toHaveBeenCalledTimes(0);
        expect(mockUpsertNewsCards).not.toHaveBeenCalled();
        expect(result).toHaveLength(2);
    });

    it('부분 hit: 15 캐시 + 5 신규 → submit 5회, 결과 20건', async () => {
        const cached = new Map(
            Array.from({ length: 15 }, (_, i) => [`n${i}`, card(`c${i}`)] as const),
        );
        mockGetNewsCards.mockResolvedValueOnce(cached);
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        mockPoll.mockImplementation(async () => ({ status: 'done', result: card('new') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = Array.from({ length: 20 }, (_, i) => makeNews(`n${i}`));
        const result = await enrichNewsCards(fakeDb, 'NVDA', news);
        expect(mockSubmit).toHaveBeenCalledTimes(5);
        expect(result).toHaveLength(20);
    });

    it('상한 정확성: 100건 입력 → 21번째 기사는 어떤 경로로도 카드 생성 안 됨', async () => {
        mockGetNewsCards.mockResolvedValueOnce(new Map());
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = Array.from({ length: 100 }, (_, i) => makeNews(`n${i}`));
        await enrichNewsCards(fakeDb, 'NVDA', news);
        const ids = mockGetNewsCards.mock.calls[0][1] as string[];
        expect(ids).toHaveLength(20);
        expect(mockSubmit).toHaveBeenCalledTimes(20);
        const rows = mockUpsertNewsCards.mock.calls[0][1] as unknown[];
        expect(rows).toHaveLength(20);
    });

    it('부분 실패: 5건 중 2건 poll error → 성공 3건만 enrich/persist', async () => {
        mockGetNewsCards.mockResolvedValueOnce(new Map());
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        let i = 0;
        mockPoll.mockImplementation(async () => {
            i += 1;
            if (i === 2 || i === 4) return { status: 'error', error: 'rate-limit' };
            return { status: 'done', result: card(`ok${i}`) };
        });
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = [1, 2, 3, 4, 5].map((n) => makeNews(`n${n}`));
        const result = await enrichNewsCards(fakeDb, 'NVDA', news);
        expect(result).toHaveLength(3);
        const persistedRows = mockUpsertNewsCards.mock.calls[0][1] as { newsId: string }[];
        expect(persistedRows).toHaveLength(3);
    });

    it('전부 실패: 5건 모두 poll error → 빈 배열 반환, upsert 호출 0회', async () => {
        mockGetNewsCards.mockResolvedValueOnce(new Map());
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        mockPoll.mockImplementation(async () => ({ status: 'error', error: 'down' }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(
            fakeDb,
            'NVDA',
            [1, 2, 3, 4, 5].map((n) => makeNews(`n${n}`)),
        );
        expect(result).toEqual([]);
        expect(mockUpsertNewsCards).not.toHaveBeenCalled();
    });

    it('submit이 non-submitted (rate-limit 등) 반환 시 해당 건 드롭, 나머지 진행', async () => {
        mockGetNewsCards.mockResolvedValueOnce(new Map());
        let i = 0;
        mockSubmit.mockImplementation(async () => {
            i += 1;
            if (i === 1) return { status: 'rate_limited' };
            return { status: 'submitted', jobId: 'j' };
        });
        mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeDb, 'NVDA', [makeNews('n1'), makeNews('n2')]);
        expect(result).toHaveLength(1);
    });

    it('submit이 throw 시에도 다른 카드는 진행', async () => {
        mockGetNewsCards.mockResolvedValueOnce(new Map());
        let i = 0;
        mockSubmit.mockImplementation(async () => {
            i += 1;
            if (i === 1) throw new Error('network');
            return { status: 'submitted', jobId: 'j' };
        });
        mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeDb, 'NVDA', [makeNews('n1'), makeNews('n2')]);
        expect(result).toHaveLength(1);
    });

    it('upsertNewsCards가 throw 시에도 메모리 카드로 결과 반환 (5.6 완화책)', async () => {
        mockGetNewsCards.mockResolvedValueOnce(new Map());
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        mockUpsertNewsCards.mockRejectedValueOnce(new Error('neon down'));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeDb, 'NVDA', [makeNews('n1'), makeNews('n2')]);
        expect(result).toHaveLength(2);
        // 핵심 invariant: persist 실패에도 메모리 카드가 실제로 결과에 실려야 함
        // (단순 length 단언만으론 undefined/빈 카드 회귀를 잡지 못함)
        expect(result[0].card.summaryKo).toBe('ok');
        expect(result[1].card.summaryKo).toBe('ok');
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    it('submit 호출 시 thinkingBudget: 0 전달', async () => {
        mockGetNewsCards.mockResolvedValueOnce(new Map());
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        await enrichNewsCards(fakeDb, 'NVDA', [makeNews('n1')]);
        expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ thinkingBudget: 0 }));
    });

    it('빈 news 입력 → 빈 배열, DB 호출도 빈 입력으로 1회 또는 생략', async () => {
        mockGetNewsCards.mockResolvedValueOnce(new Map());
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeDb, 'NVDA', []);
        expect(result).toEqual([]);
        expect(mockSubmit).not.toHaveBeenCalled();
        expect(mockUpsertNewsCards).not.toHaveBeenCalled();
    });
});
