import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NewsItem, NewsCardAnalysis } from '@y0ngha/siglens-core';
import type { NewsCardStore } from '../types';

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

vi.mock('../poll-until-done.js', () => ({
    // pollUntilDone delegates straight to pollFn(jobId) so the mock controls outcome
    pollUntilDone: async (pollFn: (id: string) => Promise<unknown>, jobId: string) => {
        const r = (await pollFn(jobId)) as { status: string; result?: unknown; error?: string };
        if (r.status === 'done') return { result: r.result };
        return { error: r.error ?? 'unknown' };
    },
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
        mockSubmit.mockReset();
        mockPoll.mockReset();
        mockGetCards.mockReset();
        mockUpsertCards.mockReset();
    });

    it('happy: 신규 5건 → submit+poll 5회 → upsert 1회 → EnrichedNewsItem 5건', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = [1, 2, 3, 4, 5].map((i) => makeNews(`n${i}`));
        const result = await enrichNewsCards(fakeStore, 'NVDA', news);
        expect(mockSubmit).toHaveBeenCalledTimes(5);
        expect(mockUpsertCards).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(5);
        expect(result[0].card.summaryKo).toBe('ok');
    });

    it('이중 과금 방지: 전부 캐시 hit → submit 호출 0회', async () => {
        const cached = new Map([
            ['n1', card('c1')],
            ['n2', card('c2')],
        ]);
        mockGetCards.mockResolvedValueOnce(cached);
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeStore, 'NVDA', [makeNews('n1'), makeNews('n2')]);
        expect(mockSubmit).toHaveBeenCalledTimes(0);
        expect(mockUpsertCards).not.toHaveBeenCalled();
        expect(result).toHaveLength(2);
    });

    it('부분 hit: 15 캐시 + 5 신규 → submit 5회, 결과 20건', async () => {
        const cached = new Map(
            Array.from({ length: 15 }, (_, i) => [`n${i}`, card(`c${i}`)] as const),
        );
        mockGetCards.mockResolvedValueOnce(cached);
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        mockPoll.mockImplementation(async () => ({ status: 'done', result: card('new') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = Array.from({ length: 20 }, (_, i) => makeNews(`n${i}`));
        const result = await enrichNewsCards(fakeStore, 'NVDA', news);
        expect(mockSubmit).toHaveBeenCalledTimes(5);
        expect(result).toHaveLength(20);
    });

    it('상한 정확성: 100건 입력 → 21번째 기사는 어떤 경로로도 카드 생성 안 됨', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = Array.from({ length: 100 }, (_, i) => makeNews(`n${i}`));
        await enrichNewsCards(fakeStore, 'NVDA', news);
        const ids = mockGetCards.mock.calls[0][0] as string[];
        expect(ids).toHaveLength(20);
        expect(mockSubmit).toHaveBeenCalledTimes(20);
        const rows = mockUpsertCards.mock.calls[0][0] as unknown[];
        expect(rows).toHaveLength(20);
    });

    it('부분 실패: 5건 중 2건 poll error → 성공 3건만 enrich/persist', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        let i = 0;
        mockPoll.mockImplementation(async () => {
            i += 1;
            // 비연속 실패 분포(2, 4): short-circuit 임계(3 연속) 미만이라 끝까지 진행.
            if (i === 2 || i === 4) return { status: 'error', error: 'rate-limit' };
            return { status: 'done', result: card(`ok${i}`) };
        });
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = [1, 2, 3, 4, 5].map((n) => makeNews(`n${n}`));
        const result = await enrichNewsCards(fakeStore, 'NVDA', news);
        expect(result).toHaveLength(3);
        const persistedRows = mockUpsertCards.mock.calls[0][0] as { newsId: string }[];
        expect(persistedRows).toHaveLength(3);
    });

    it('전부 실패: 5건 모두 poll error → 빈 배열 반환, upsert 호출 0회', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        mockPoll.mockImplementation(async () => ({ status: 'error', error: 'down' }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(
            fakeStore,
            'NVDA',
            [1, 2, 3, 4, 5].map((n) => makeNews(`n${n}`)),
        );
        expect(result).toEqual([]);
        expect(mockUpsertCards).not.toHaveBeenCalled();
    });

    it('submit이 non-submitted (rate-limit 등) 반환 시 해당 건 드롭, 나머지 진행', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        let i = 0;
        mockSubmit.mockImplementation(async () => {
            i += 1;
            if (i === 1) return { status: 'rate_limited' };
            return { status: 'submitted', jobId: 'j' };
        });
        mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeStore, 'NVDA', [makeNews('n1'), makeNews('n2')]);
        expect(result).toHaveLength(1);
    });

    it('submit이 throw 시에도 다른 카드는 진행', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        let i = 0;
        mockSubmit.mockImplementation(async () => {
            i += 1;
            if (i === 1) throw new Error('network');
            return { status: 'submitted', jobId: 'j' };
        });
        mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeStore, 'NVDA', [makeNews('n1'), makeNews('n2')]);
        expect(result).toHaveLength(1);
    });

    it('upsertCards가 throw 시에도 메모리 카드로 결과 반환 (persist 실패 완화책)', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        mockUpsertCards.mockRejectedValueOnce(new Error('neon down'));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeStore, 'NVDA', [makeNews('n1'), makeNews('n2')]);
        expect(result).toHaveLength(2);
        // 핵심 invariant: persist 실패에도 메모리 카드가 실제로 결과에 실려야 함
        expect(result[0].card.summaryKo).toBe('ok');
        expect(result[1].card.summaryKo).toBe('ok');
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    it('submit 호출 시 thinkingBudget: 0 전달', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
        const { enrichNewsCards } = await import('../enrich-news-cards');
        await enrichNewsCards(fakeStore, 'NVDA', [makeNews('n1')]);
        expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ thinkingBudget: 0 }));
    });

    it('빈 news 입력 → 빈 배열, submit/upsert 모두 호출 없음', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const result = await enrichNewsCards(fakeStore, 'NVDA', []);
        expect(result).toEqual([]);
        expect(mockSubmit).not.toHaveBeenCalled();
        expect(mockUpsertCards).not.toHaveBeenCalled();
    });

    it('short-circuit: 연속 3건 poll error → 4번째부터는 submit 호출되지 않음', async () => {
        mockGetCards.mockResolvedValueOnce(new Map());
        mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
        mockPoll.mockImplementation(async () => ({ status: 'error', error: 'worker down' }));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { enrichNewsCards } = await import('../enrich-news-cards');
        const news = [1, 2, 3, 4, 5].map((n) => makeNews(`n${n}`));
        const result = await enrichNewsCards(fakeStore, 'NVDA', news);
        // 3건만 submit 시도하고 4·5번째는 short-circuit으로 스킵
        expect(mockSubmit).toHaveBeenCalledTimes(3);
        expect(result).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
            '[enrich-news-cards] short-circuit',
            expect.objectContaining({ consecutiveFailures: 3 }),
        );
        warnSpy.mockRestore();
    });
});
