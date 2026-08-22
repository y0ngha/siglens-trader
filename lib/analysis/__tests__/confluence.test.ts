import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBars = vi.fn();
const evaluateConfluence = vi.fn();

vi.mock('../../data/fmp-market-data-provider.js', () => ({
    getMarketDataProvider: () => ({ getBars }),
}));

/**
 * `evaluateConfluence`(core 소유)는 mock한다.
 *
 * 룰 자체는 core가 45건으로 검증한다 — 여기서 다시 검증하면 같은 것을 두 곳에서 세는
 * 셈이고, 이 파일이 지켜야 할 것은 **trader가 소유한 층**이다: 봉 조회, 최소 봉 게이트,
 * 봉 신선도, 상위 시간축 캐시, 그리고 옵션이 core까지 온전히 전달되는가.
 */
vi.mock('@y0ngha/siglens-core', () => ({
    evaluateConfluence: (...args: unknown[]) => evaluateConfluence(...args),
    // 상수는 실제 값을 그대로 — `MIN_BARS`가 여기서 나오므로 빠지면 봉 게이트가
    // undefined 비교가 되어 조용히 통과한다.
    CONFLUENCE_MIN_BARS: 120,
}));

const { computeConfluence, MIN_BARS, DEFAULT_HTF_TIMEFRAME, __clearHtfCache } =
    await import('../confluence.js');

/** 종가가 모두 `close`인 n개 봉. 마지막 봉은 **방금** 닫힌 것으로 만든다. */
function bars(n: number, close = 100) {
    const lastTime = Math.floor(Date.now() / 1000);
    return Array.from({ length: n }, (_, i) => ({
        time: lastTime - (n - 1 - i) * 3600,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1000,
    }));
}

/** 마지막 봉이 `ageHours` 시간 전인 n개 봉. */
function staleBars(n: number, ageHours: number, close = 100) {
    const lastTime = Math.floor(Date.now() / 1000) - ageHours * 3600;
    return Array.from({ length: n }, (_, i) => ({
        time: lastTime - (n - 1 - i) * 3600,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1000,
    }));
}

/** 타임프레임에 따라 본 봉 / 상위 봉을 갈라 주는 기본 구현. */
function barsByTimeframe(intraday = bars(MIN_BARS + 1), daily = bars(300, 90)) {
    return (o: { timeframe: string }) => Promise.resolve(o.timeframe === '1Day' ? daily : intraday);
}

const SNAP = { timeframe: '1Hour', entryTrigger: false } as never;

beforeEach(() => {
    vi.clearAllMocks();
    __clearHtfCache();
    evaluateConfluence.mockReturnValue(SNAP);
    getBars.mockImplementation(barsByTimeframe());
});

describe('computeConfluence — 조회와 게이트 (trader 소유)', () => {
    describe('기권', () => {
        it('봉이 MIN_BARS 이하면 core를 부르지도 않는다', async () => {
            getBars.mockImplementation(barsByTimeframe(bars(MIN_BARS)));

            expect(await computeConfluence('AAPL', '1Hour')).toBeNull();
            expect(evaluateConfluence).not.toHaveBeenCalled();
        });

        it('봉 조회가 실패하면 null', async () => {
            getBars.mockRejectedValue(new Error('fmp down'));
            expect(await computeConfluence('AAPL', '1Hour')).toBeNull();
        });

        it('봉이 배열이 아니면 null', async () => {
            getBars.mockResolvedValue(null);
            expect(await computeConfluence('AAPL', '1Hour')).toBeNull();
        });

        it('마지막 종가가 비정상이면 null', async () => {
            const rows = bars(MIN_BARS + 1);
            rows[rows.length - 1]!.close = Number.NaN;
            getBars.mockImplementation(barsByTimeframe(rows));

            expect(await computeConfluence('AAPL', '1Hour')).toBeNull();
            expect(evaluateConfluence).not.toHaveBeenCalled();
        });

        it('마지막 봉이 낡았으면 기권한다 — 전 세션 종가로 트리거가 서면 안 된다', async () => {
            getBars.mockImplementation(barsByTimeframe(staleBars(MIN_BARS + 1, 24)));

            expect(await computeConfluence('AAPL', '1Hour')).toBeNull();
            expect(evaluateConfluence).not.toHaveBeenCalled();
        });

        it('타임프레임 × 3 안이면 기권하지 않는다', async () => {
            getBars.mockImplementation(barsByTimeframe(staleBars(MIN_BARS + 1, 1)));
            expect(await computeConfluence('AAPL', '1Hour')).not.toBeNull();
        });

        it('core가 null을 돌려주면 그대로 null', async () => {
            evaluateConfluence.mockReturnValue(null);
            expect(await computeConfluence('AAPL', '1Hour')).toBeNull();
        });
    });

    describe('core로의 위임', () => {
        it('본 봉과 타임프레임 라벨을 넘긴다', async () => {
            const intraday = bars(MIN_BARS + 1);
            getBars.mockImplementation(barsByTimeframe(intraday));

            await computeConfluence('AAPL', '30Min');

            expect(evaluateConfluence).toHaveBeenCalledWith(
                intraday,
                expect.objectContaining({ timeframe: '30Min', minBars: MIN_BARS }),
            );
        });

        it('설정된 튜너블만 넘긴다 — 미지정 키는 core 기본값이 살아야 한다', async () => {
            await computeConfluence('AAPL', '1Hour', { min: 4, requireVolume: false });

            const opts = evaluateConfluence.mock.calls[0]![1] as Record<string, unknown>;
            expect(opts.min).toBe(4);
            expect(opts.requireVolume).toBe(false);
            expect('span' in opts).toBe(false);
            expect('expectedWeight' in opts).toBe(false);
        });

        it('튜너블 전부를 넘길 수 있다', async () => {
            await computeConfluence('AAPL', '1Hour', {
                min: 4,
                span: 20,
                expectedWeight: 0.25,
                requireVolume: true,
            });

            expect(evaluateConfluence).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    min: 4,
                    span: 20,
                    expectedWeight: 0.25,
                    requireVolume: true,
                }),
            );
        });
    });

    describe('상위 시간축 봉', () => {
        it('기본값으로 일봉을 함께 조회해 넘긴다', async () => {
            const intraday = bars(MIN_BARS + 1);
            const daily = bars(300, 90);
            getBars.mockImplementation(barsByTimeframe(intraday, daily));

            await computeConfluence('AAPL', '30Min');

            expect(getBars).toHaveBeenCalledWith(
                expect.objectContaining({ symbol: 'AAPL', timeframe: DEFAULT_HTF_TIMEFRAME }),
            );
            expect(evaluateConfluence).toHaveBeenCalledWith(
                intraday,
                expect.objectContaining({ htfBars: daily, htfLabel: '1Day' }),
            );
        });

        it('htf: null이면 상위 봉을 조회하지 않는다', async () => {
            await computeConfluence('AAPL', '1Hour', { htf: null });

            expect(getBars).toHaveBeenCalledTimes(1);
            expect(evaluateConfluence).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ htfBars: null, htfLabel: null }),
            );
        });

        it('상위 봉 조회가 실패하면 null로 넘긴다 (fail-open)', async () => {
            getBars.mockImplementation((o: { timeframe: string }) =>
                o.timeframe === '1Day'
                    ? Promise.reject(new Error('fmp down'))
                    : Promise.resolve(bars(MIN_BARS + 1)),
            );

            await computeConfluence('AAPL', '1Hour');

            expect(evaluateConfluence).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ htfBars: null }),
            );
        });

        it('빈 상위 봉도 null로 넘긴다', async () => {
            getBars.mockImplementation(barsByTimeframe(bars(MIN_BARS + 1), []));

            await computeConfluence('AAPL', '1Hour');

            expect(evaluateConfluence).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ htfBars: null }),
            );
        });

        it('성공한 조회는 캐시한다 — 일봉은 마감 후에만 바뀐다', async () => {
            await computeConfluence('AAPL', '1Hour');
            const afterFirst = getBars.mock.calls.length;

            await computeConfluence('AAPL', '1Hour');

            // 두 번째 런은 본 봉 1회만.
            expect(getBars.mock.calls.length - afterFirst).toBe(1);
        });

        it('심볼마다 따로 캐시한다', async () => {
            await computeConfluence('AAPL', '1Hour');
            const afterAapl = getBars.mock.calls.length;

            await computeConfluence('MSFT', '1Hour');

            // 다른 심볼은 캐시에 없으니 본 봉 + 상위 봉 = 2회.
            expect(getBars.mock.calls.length - afterAapl).toBe(2);
        });

        it('실패는 짧게만 캐시한다 — FMP 딸꾹질이 게이트를 한 시간 끄면 안 된다', async () => {
            vi.useFakeTimers();
            try {
                getBars.mockImplementation((o: { timeframe: string }) =>
                    o.timeframe === '1Day'
                        ? Promise.reject(new Error('fmp down'))
                        : Promise.resolve(bars(MIN_BARS + 1)),
                );
                await computeConfluence('AAPL', '1Hour');
                const afterFail = getBars.mock.calls.length;

                // 6분 뒤: 실패 TTL(5분)이 지나 재시도해야 한다.
                vi.advanceTimersByTime(6 * 60_000);
                getBars.mockImplementation(barsByTimeframe());
                await computeConfluence('AAPL', '1Hour');

                // 본 봉 + 상위 봉 재조회 = 2회
                expect(getBars.mock.calls.length - afterFail).toBe(2);
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
