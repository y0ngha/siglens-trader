import { describe, it, expect } from 'vitest';
import { DEFAULT_WEIGHTS, WEIGHTS_BY_TIMEFRAME, weightsForTimeframe } from '../types';
import { scoreSignals } from '../signal-scorer';
import { ANALYSIS_TIMEFRAMES } from '../../analysis/timeframe';

describe('weightsForTimeframe', () => {
    it('covers every analysis timeframe the app can be configured with', () => {
        for (const tf of ANALYSIS_TIMEFRAMES) {
            expect(WEIGHTS_BY_TIMEFRAME[tf]).toBeDefined();
        }
    });

    it('falls back to the baseline for an unrecognized timeframe', () => {
        expect(weightsForTimeframe('1Day')).toEqual(DEFAULT_WEIGHTS);
    });

    it('keeps 1Hour on the existing baseline', () => {
        expect(weightsForTimeframe('1Hour')).toEqual(DEFAULT_WEIGHTS);
    });

    it('shrinks the slow signals and favors price action as the horizon shortens', () => {
        const hour = weightsForTimeframe('1Hour');
        const half = weightsForTimeframe('30Min');
        const quarter = weightsForTimeframe('15Min');

        // Congressional disclosures surface weeks late and fundamentals move on quarters —
        // both must matter less to a 15-minute decision than to an hourly one.
        expect(quarter.congress).toBeLessThan(half.congress);
        expect(half.congress).toBeLessThan(hour.congress);
        expect(quarter.fundamental).toBeLessThan(half.fundamental);
        expect(half.fundamental).toBeLessThan(hour.fundamental);

        // Price action picks up the slack.
        expect(quarter.technical).toBeGreaterThan(half.technical);
        expect(half.technical).toBeGreaterThan(hour.technical);
        expect(quarter.options).toBeGreaterThanOrEqual(hour.options);
    });

    it('changes the verdict when a slow signal disagrees on a short horizon', () => {
        // Technical and options are bullish, fundamental is bearish. On an hourly horizon the
        // fundamental drag is heavy enough to hold; on 15Min it should not veto the trade.
        const inputs = {
            technical: { trend: 'bullish' as const, riskLevel: 'low' },
            news: { overallSentiment: 'bullish' },
            options: { signals: [{ kind: 'bullish' }, { kind: 'bullish' }, { kind: 'bullish' }] },
            fundamental: { overallSentiment: 'bearish' },
            congress: null,
        };

        const hourly = scoreSignals(inputs, weightsForTimeframe('1Hour'), 70, 30);
        const short = scoreSignals(inputs, weightsForTimeframe('15Min'), 70, 30);

        expect(short.total).toBeGreaterThan(hourly.total);
    });
});

describe('confluence 가중치', () => {
    it('기본 프로파일에서 confluence가 최상위 가중치를 갖는다', () => {
        const w = DEFAULT_WEIGHTS;
        expect(w.confluence).toBe(12);
        expect(w.confluence).toBeGreaterThan(w.technical);
        expect(w.confluence).toBeGreaterThan(w.news);
        expect(w.confluence).toBeGreaterThan(w.options);
        expect(w.confluence).toBeGreaterThan(w.fundamental);
        expect(w.confluence).toBeGreaterThan(w.congress);
    });

    it('모든 타임프레임 프로파일에서 confluence가 최상위다', () => {
        for (const tf of ['15Min', '30Min', '1Hour'] as const) {
            const w = weightsForTimeframe(tf);
            const others = [w.technical, w.news, w.options, w.fundamental, w.congress];
            expect(w.confluence).toBeGreaterThan(Math.max(...others));
        }
    });

    it('짧은 타임프레임일수록 confluence 비중이 커진다', () => {
        const share = (tf: string) => {
            const w = weightsForTimeframe(tf);
            const total =
                w.confluence + w.technical + w.news + w.options + w.fundamental + w.congress;
            return w.confluence / total;
        };
        expect(share('15Min')).toBeGreaterThan(share('30Min'));
        expect(share('30Min')).toBeGreaterThan(share('1Hour'));
    });
});
