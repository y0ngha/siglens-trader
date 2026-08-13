import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBars = vi.fn();
const calculateIndicators = vi.fn();
const detectSignals = vi.fn();

vi.mock('../../data/fmp-market-data-provider.js', () => ({
    getMarketDataProvider: () => ({ getBars }),
}));

vi.mock('@y0ngha/siglens-core', () => ({
    calculateIndicators: (...args: unknown[]) => calculateIndicators(...args),
    detectSignals: (...args: unknown[]) => detectSignals(...args),
}));

const { computeConfluence, MIN_BARS } = await import('../confluence.js');

/** 종가가 모두 `close`인 n개 봉. */
function bars(n: number, close = 100) {
    return Array.from({ length: n }, (_, i) => ({
        time: 1_760_000_000 + i * 3600,
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
});

describe('computeConfluence', () => {
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

    it('강세 3종 + 신규 1종 + 종가>MA50 이면 entryTrigger', async () => {
        const rows = [...bars(MIN_BARS, 90), ...bars(1, 200)];
        getBars.mockResolvedValue(rows);
        detectSignals
            .mockReturnValueOnce([sig('a', 'bullish'), sig('b', 'bullish'), sig('c', 'bullish')])
            .mockReturnValueOnce([sig('a', 'bullish'), sig('b', 'bullish')]);

        const snap = await computeConfluence('AAPL', '1Hour');

        expect(snap!.entryTrigger).toBe(true);
        expect(snap!.exitTrigger).toBe(false);
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
