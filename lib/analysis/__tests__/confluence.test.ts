import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBars = vi.fn();
const calculateIndicators = vi.fn();
const detectSignals = vi.fn();
const classifyTrend = vi.fn();

vi.mock('../../data/fmp-market-data-provider.js', () => ({
    getMarketDataProvider: () => ({ getBars }),
}));

vi.mock('@y0ngha/siglens-core', () => ({
    calculateIndicators: (...args: unknown[]) => calculateIndicators(...args),
    detectSignals: (...args: unknown[]) => detectSignals(...args),
    classifyTrend: (...args: unknown[]) => classifyTrend(...args),
}));

const { computeConfluence, MIN_BARS, __clearHtfCache } = await import('../confluence.js');

/**
 * 진입 트리거를 세우는 기본 강세 3계열. 거래량 계열(cmf)이 하나 포함돼야 한다 —
 * 게이트가 요구하기 때문이고, 그게 이 픽스처의 요점이다.
 */
const BULL3 = ['cci_bullish_cross', 'cmf_bullish_flip', 'dmi_bullish_cross'];

/**
 * 종가가 모두 `close`인 n개 봉. 마지막 봉은 **방금** 닫힌 것으로 만든다 —
 * `computeConfluence`가 낡은 봉을 기권 처리하기 때문이다.
 */
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

function sig(type: string, direction: 'bullish' | 'bearish') {
    return { type, direction, phase: 'confirmed', detectedAt: 0 };
}

beforeEach(() => {
    vi.clearAllMocks();
    calculateIndicators.mockReturnValue({});
    // 상위 시간축 캐시는 모듈 스코프라 테스트 간에 살아남는다. 비우지 않으면 앞 테스트의
    // 추세 판정이 뒤 테스트로 새어 게이트 검증이 무의미해진다.
    __clearHtfCache();
    classifyTrend.mockReturnValue('uptrend');
});

describe('computeConfluence', () => {
    it('마지막 봉이 낡았으면 기권한다 — 전 세션 종가로 진입 트리거가 서면 안 된다', async () => {
        getBars.mockResolvedValue(staleBars(MIN_BARS + 1, 24));
        detectSignals.mockReturnValue([]);

        expect(await computeConfluence('AAPL', '1Hour')).toBeNull();
        // 봉이 낡으면 지표 계산 자체를 하지 않는다.
        expect(detectSignals).not.toHaveBeenCalled();
    });

    it('타임프레임 × 3 안이면 기권하지 않는다', async () => {
        getBars.mockResolvedValue(staleBars(MIN_BARS + 1, 2));
        detectSignals.mockReturnValue([]);

        expect(await computeConfluence('AAPL', '1Hour')).not.toBeNull();
    });

    it('봉이 충분하면 스냅샷을 만든다', async () => {
        getBars.mockResolvedValue(bars(MIN_BARS + 1));
        detectSignals
            .mockReturnValueOnce([
                sig('cci_bullish_cross', 'bullish'),
                sig('parabolic_sar_flip', 'bullish'),
                sig('dmi_bullish_cross', 'bullish'),
            ])
            .mockReturnValueOnce([
                sig('parabolic_sar_flip', 'bullish'),
                sig('dmi_bullish_cross', 'bullish'),
            ]);

        const snap = await computeConfluence('AAPL', '1Hour');

        expect(snap).not.toBeNull();
        expect(snap!.bullish).toEqual([
            'cci_bullish_cross',
            'dmi_bullish_cross',
            'parabolic_sar_flip',
        ]);
        expect(snap!.freshBullish).toEqual(['cci_bullish_cross']);
        expect(snap!.ma50).toBe(100);
        expect(snap!.timeframe).toBe('1Hour');
    });

    it('강세 3계열 + 신규 1종 + 종가>MA50 + 상위추세 정렬 + 거래량이면 entryTrigger', async () => {
        const rows = [...bars(MIN_BARS, 90), ...bars(1, 200)];
        getBars.mockResolvedValue(rows);
        classifyTrend.mockReturnValue('uptrend');
        detectSignals
            .mockReturnValueOnce(BULL3.map((t) => sig(t, 'bullish')))
            .mockReturnValueOnce(BULL3.slice(0, 2).map((t) => sig(t, 'bullish')));

        const snap = await computeConfluence('AAPL', '1Hour');

        expect(snap!.entryTrigger).toBe(true);
        expect(snap!.exitTrigger).toBe(false);
        expect(snap!.htfTrend).toBe('uptrend');
    });

    describe('상위 시간축 정렬 게이트', () => {
        function setupBull() {
            const rows = [...bars(MIN_BARS, 90), ...bars(1, 200)];
            getBars.mockResolvedValue(rows);
            detectSignals
                .mockReturnValueOnce(BULL3.map((t) => sig(t, 'bullish')))
                .mockReturnValueOnce(BULL3.slice(0, 2).map((t) => sig(t, 'bullish')));
        }

        it('상위 추세가 하락이면 진입 트리거가 서지 않는다', async () => {
            setupBull();
            classifyTrend.mockReturnValue('downtrend');

            const snap = await computeConfluence('AAPL', '1Hour');

            expect(snap!.entryTrigger).toBe(false);
            expect(snap!.htfTrend).toBe('downtrend');
        });

        it('횡보도 막는다 — 정렬을 요구하는 게이트다', async () => {
            setupBull();
            classifyTrend.mockReturnValue('sideways');

            expect((await computeConfluence('AAPL', '1Hour'))!.entryTrigger).toBe(false);
        });

        it('htf: null이면 게이트가 꺼지고 상위 봉을 조회하지도 않는다', async () => {
            setupBull();
            const callsBefore = getBars.mock.calls.length;

            const snap = await computeConfluence('AAPL', '1Hour', { htf: null });

            expect(snap!.entryTrigger).toBe(true);
            expect(snap!.htfTrend).toBeNull();
            expect(getBars.mock.calls.length - callsBefore).toBe(1); // 본 봉 1회뿐
        });

        it('상위 봉 조회가 실패하면 게이트를 적용하지 않는다 (fail-open)', async () => {
            const rows = [...bars(MIN_BARS, 90), ...bars(1, 200)];
            getBars.mockResolvedValueOnce(rows).mockRejectedValueOnce(new Error('fmp down'));
            detectSignals
                .mockReturnValueOnce(BULL3.map((t) => sig(t, 'bullish')))
                .mockReturnValueOnce(BULL3.slice(0, 2).map((t) => sig(t, 'bullish')));

            const snap = await computeConfluence('AAPL', '1Hour');

            expect(snap!.htfTrend).toBeNull();
            expect(snap!.entryTrigger).toBe(true);
        });

        it('성공 판정은 캐시해 상위 봉을 다시 조회하지 않는다', async () => {
            setupBull();
            classifyTrend.mockReturnValue('uptrend');
            await computeConfluence('AAPL', '1Hour');
            const afterFirst = getBars.mock.calls.length;

            setupBull();
            await computeConfluence('AAPL', '1Hour');

            // 두 번째 런은 본 봉 1회만 — 상위 봉은 캐시에서 온다.
            expect(getBars.mock.calls.length - afterFirst).toBe(1);
        });

        it('실패는 짧게만 캐시한다 — FMP 딸꾹질이 게이트를 한 시간 끄면 안 된다', async () => {
            vi.useFakeTimers();
            try {
                const rows = [...bars(MIN_BARS, 90), ...bars(1, 200)];
                getBars.mockResolvedValueOnce(rows).mockRejectedValueOnce(new Error('fmp down'));
                detectSignals
                    .mockReturnValueOnce(BULL3.map((t) => sig(t, 'bullish')))
                    .mockReturnValueOnce(BULL3.slice(0, 2).map((t) => sig(t, 'bullish')));
                expect((await computeConfluence('AAPL', '1Hour'))!.htfTrend).toBeNull();
                const afterFail = getBars.mock.calls.length;

                // 6분 뒤: 실패 TTL(5분)이 지나 재시도해야 한다.
                vi.advanceTimersByTime(6 * 60_000);
                getBars.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows);
                detectSignals
                    .mockReturnValueOnce(BULL3.map((t) => sig(t, 'bullish')))
                    .mockReturnValueOnce(BULL3.slice(0, 2).map((t) => sig(t, 'bullish')));
                classifyTrend.mockReturnValue('uptrend');

                const snap = await computeConfluence('AAPL', '1Hour');

                // 본 봉 + 상위 봉 재조회 = 2회
                expect(getBars.mock.calls.length - afterFail).toBe(2);
                expect(snap!.htfTrend).toBe('uptrend');
            } finally {
                vi.useRealTimers();
            }
        });

        it('청산 트리거는 상위 추세를 보지 않는다 — 원칙 7', async () => {
            const rows = [...bars(MIN_BARS, 200), ...bars(1, 50)];
            getBars.mockResolvedValue(rows);
            classifyTrend.mockReturnValue('uptrend'); // 진입이면 막힐 상황
            const bear3 = ['cci_bearish_cross', 'dmi_bearish_cross', 'supertrend_bearish_flip'];
            detectSignals
                .mockReturnValueOnce(bear3.map((t) => sig(t, 'bearish')))
                .mockReturnValueOnce(bear3.slice(0, 2).map((t) => sig(t, 'bearish')));

            expect((await computeConfluence('AAPL', '1Hour'))!.exitTrigger).toBe(true);
        });
    });

    describe('거래량 게이트', () => {
        it('거래량 계열이 없으면 진입 트리거가 서지 않는다', async () => {
            const rows = [...bars(MIN_BARS, 90), ...bars(1, 200)];
            getBars.mockResolvedValue(rows);
            classifyTrend.mockReturnValue('uptrend');
            const noVolume = ['cci_bullish_cross', 'dmi_bullish_cross', 'supertrend_bullish_flip'];
            detectSignals
                .mockReturnValueOnce(noVolume.map((t) => sig(t, 'bullish')))
                .mockReturnValueOnce(noVolume.slice(0, 2).map((t) => sig(t, 'bullish')));

            expect((await computeConfluence('AAPL', '1Hour'))!.entryTrigger).toBe(false);
        });

        it('requireVolume: false면 게이트가 꺼진다', async () => {
            const rows = [...bars(MIN_BARS, 90), ...bars(1, 200)];
            getBars.mockResolvedValue(rows);
            classifyTrend.mockReturnValue('uptrend');
            const noVolume = ['cci_bullish_cross', 'dmi_bullish_cross', 'supertrend_bullish_flip'];
            detectSignals
                .mockReturnValueOnce(noVolume.map((t) => sig(t, 'bullish')))
                .mockReturnValueOnce(noVolume.slice(0, 2).map((t) => sig(t, 'bullish')));

            const snap = await computeConfluence('AAPL', '1Hour', { requireVolume: false });
            expect(snap!.entryTrigger).toBe(true);
        });

        it('mfi도 거래량 계열로 인정한다', async () => {
            const rows = [...bars(MIN_BARS, 90), ...bars(1, 200)];
            getBars.mockResolvedValue(rows);
            classifyTrend.mockReturnValue('uptrend');
            const withMfi = ['cci_bullish_cross', 'mfi_oversold_bounce', 'dmi_bullish_cross'];
            detectSignals
                .mockReturnValueOnce(withMfi.map((t) => sig(t, 'bullish')))
                .mockReturnValueOnce(withMfi.slice(0, 2).map((t) => sig(t, 'bullish')));

            expect((await computeConfluence('AAPL', '1Hour'))!.entryTrigger).toBe(true);
        });
    });

    describe('파라미터', () => {
        it('적용된 파라미터를 스냅샷에 남긴다 — 과거 행의 채점 근거', async () => {
            getBars.mockResolvedValue(bars(MIN_BARS + 1));
            classifyTrend.mockReturnValue('uptrend');
            detectSignals.mockReturnValue([]);

            const snap = await computeConfluence('AAPL', '1Hour', {
                min: 4,
                span: 20,
                expectedWeight: 0.25,
                requireVolume: false,
            });

            expect(snap!.params).toEqual({
                min: 4,
                span: 20,
                expectedWeight: 0.25,
                htf: '1Day',
                requireVolume: false,
            });
        });

        it('비정상 파라미터는 기본값으로 되돌린다', async () => {
            getBars.mockResolvedValue(bars(MIN_BARS + 1));
            classifyTrend.mockReturnValue('uptrend');
            detectSignals.mockReturnValue([]);

            const snap = await computeConfluence('AAPL', '1Hour', {
                min: Number.NaN,
                span: -5,
                expectedWeight: 9,
            });

            expect(snap!.params!.min).toBe(3);
            expect(snap!.params!.span).toBe(15);
            expect(snap!.params!.expectedWeight).toBe(1);
        });

        it('min을 올리면 계열이 모자라 트리거가 서지 않는다', async () => {
            const rows = [...bars(MIN_BARS, 90), ...bars(1, 200)];
            getBars.mockResolvedValue(rows);
            classifyTrend.mockReturnValue('uptrend');
            detectSignals
                .mockReturnValueOnce(BULL3.map((t) => sig(t, 'bullish')))
                .mockReturnValueOnce(BULL3.slice(0, 2).map((t) => sig(t, 'bullish')));

            expect((await computeConfluence('AAPL', '1Hour', { min: 4 }))!.entryTrigger).toBe(
                false,
            );
        });
    });

    it('약세 3종 + 신규 1종 + 종가<MA50 이면 exitTrigger', async () => {
        const rows = [...bars(MIN_BARS, 200), ...bars(1, 50)];
        getBars.mockResolvedValue(rows);
        detectSignals
            .mockReturnValueOnce([sig('a', 'bearish'), sig('b', 'bearish'), sig('c', 'bearish')])
            .mockReturnValueOnce([sig('a', 'bearish'), sig('b', 'bearish')]);

        const snap = await computeConfluence('AAPL', '1Hour');

        expect(snap!.exitTrigger).toBe(true);
        expect(snap!.entryTrigger).toBe(false);
    });

    it('봉이 MIN_BARS 이하면 null (기권)', async () => {
        getBars.mockResolvedValue(bars(MIN_BARS));
        expect(await computeConfluence('AAPL', '1Hour')).toBeNull();
    });

    it('봉 조회가 실패하면 null', async () => {
        getBars.mockRejectedValue(new Error('FMP 500'));
        expect(await computeConfluence('AAPL', '1Hour')).toBeNull();
    });

    it('빈 배열이면 null', async () => {
        getBars.mockResolvedValue([]);
        expect(await computeConfluence('AAPL', '1Hour')).toBeNull();
    });

    it('detectSignals가 던져도 null (매매를 멈추지 않는다)', async () => {
        getBars.mockResolvedValue(bars(MIN_BARS + 1));
        detectSignals.mockImplementation(() => {
            throw new Error('core boom');
        });
        expect(await computeConfluence('AAPL', '1Hour')).toBeNull();
    });

    it('마지막 종가가 유한 양수가 아니면 null', async () => {
        const rows = bars(MIN_BARS + 1);
        rows[rows.length - 1]!.close = Number.NaN;
        getBars.mockResolvedValue(rows);
        detectSignals.mockReturnValue([]);
        expect(await computeConfluence('AAPL', '1Hour')).toBeNull();
    });

    it('provider가 배열이 아닌 값을 주면 null (로그 경로 포함)', async () => {
        getBars.mockResolvedValue(undefined);
        expect(await computeConfluence('AAPL', '1Hour')).toBeNull();
        expect(detectSignals).not.toHaveBeenCalled();
    });

    it('MA 구간 안에 비정상 종가가 있으면 ma50은 null이고 트리거는 서지 않는다', async () => {
        const rows = bars(MIN_BARS + 1);
        // 마지막 봉은 멀쩡하지만 SMA(50) 창 안의 한 봉이 깨졌다 — 평균을 낼 수 없다.
        rows[rows.length - 10]!.close = Number.NaN;
        getBars.mockResolvedValue(rows);
        detectSignals
            .mockReturnValueOnce([sig('a', 'bullish'), sig('b', 'bullish'), sig('c', 'bullish')])
            .mockReturnValueOnce([]);

        const snap = await computeConfluence('AAPL', '1Hour');

        expect(snap!.ma50).toBeNull();
        expect(snap!.entryTrigger).toBe(false);
    });

    it('종가 합이 오버플로하면 ma50은 null', async () => {
        const rows = bars(MIN_BARS + 1, Number.MAX_VALUE);
        getBars.mockResolvedValue(rows);
        detectSignals.mockReturnValue([]);

        const snap = await computeConfluence('AAPL', '1Hour');

        expect(snap!.ma50).toBeNull();
    });

    it('타임프레임별 룩백 일수로 from을 계산한다', async () => {
        getBars.mockResolvedValue([]);
        await computeConfluence('AAPL', '15Min');
        expect(getBars).toHaveBeenCalledWith(
            expect.objectContaining({ symbol: 'AAPL', timeframe: '15Min' }),
        );
        expect(getBars.mock.calls[0]![0].from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('entryTrigger와 exitTrigger는 동시에 설 수 없다', async () => {
        // 종가는 MA50보다 크거나 작거나 하나뿐이므로 구조적으로 상호배타여야 한다.
        const rows = [...bars(MIN_BARS, 90), ...bars(1, 200)];
        getBars.mockResolvedValue(rows);
        detectSignals
            .mockReturnValueOnce([
                sig('a', 'bullish'),
                sig('b', 'bullish'),
                sig('c', 'bullish'),
                sig('x', 'bearish'),
                sig('y', 'bearish'),
                sig('z', 'bearish'),
            ])
            .mockReturnValueOnce([]);

        const snap = await computeConfluence('AAPL', '1Hour');
        expect(snap!.entryTrigger && snap!.exitTrigger).toBe(false);
    });
});
