import { describe, it, expect } from 'vitest';
import type { PriorAnalysisRow } from '../types';
import { mapRowsToPriorAnalyses } from '../prior-analysis';

function row(result: unknown, analyzedAt = new Date('2026-05-24T09:00:00.000Z')): PriorAnalysisRow {
    return { result, analyzedAt };
}

describe('mapRowsToPriorAnalyses', () => {
    it('trend/riskLevel과 actionRecommendation 가격 세 종류를 core의 PriorAnalysis로 매핑한다', () => {
        const rows = [
            row({
                trend: 'bullish',
                riskLevel: 'medium',
                actionRecommendation: {
                    entryPrices: [148, 152],
                    stopLoss: 140,
                    takeProfitPrices: [170, 185],
                },
            }),
        ];

        expect(mapRowsToPriorAnalyses(rows)).toEqual([
            {
                generatedAt: rows[0]!.analyzedAt,
                trend: 'bullish',
                riskLevel: 'medium',
                entryPrices: [148, 152],
                stopLoss: 140,
                takeProfitPrices: [170, 185],
            },
        ]);
    });

    it('trend나 riskLevel이 없으면 그 행을 통째로 스킵한다', () => {
        expect(mapRowsToPriorAnalyses([row({ riskLevel: 'medium' })])).toEqual([]);
        expect(mapRowsToPriorAnalyses([row({ trend: 'bullish' })])).toEqual([]);
    });

    it('trend/riskLevel이 문자열이 아니면 스킵한다 — 구버전 프롬프트가 남긴 다른 모양', () => {
        expect(mapRowsToPriorAnalyses([row({ trend: 1, riskLevel: 'medium' })])).toEqual([]);
        expect(mapRowsToPriorAnalyses([row({ trend: 'bullish', riskLevel: null })])).toEqual([]);
    });

    it('trend/riskLevel이 유니온 밖 문자열이면 스킵한다 — 타입만으로는 안 걸린다', () => {
        // `typeof === 'string'`만 보면 통과해 캐스팅된다. 런타임에 터지지도 않는다 —
        // core 렌더러가 그 값을 그대로 보간해 **"과거에 이렇게 판단했다"는 사실 진술로**
        // 프롬프트에 싣는다. 모델이 자기 과거 판단을 사실 대조하게 만드는 기능인데
        // 그 사실 자체가 거짓이 된다.
        expect(mapRowsToPriorAnalyses([row({ trend: 'sideways', riskLevel: 'medium' })])).toEqual(
            [],
        );
        expect(mapRowsToPriorAnalyses([row({ trend: 'bullish', riskLevel: 'extreme' })])).toEqual(
            [],
        );
    });

    it('result가 null/객체가 아니면 스킵한다', () => {
        expect(mapRowsToPriorAnalyses([row(null)])).toEqual([]);
        expect(mapRowsToPriorAnalyses([row('not-an-object')])).toEqual([]);
    });

    it('가격 필드가 없거나 비정상이어도 trend/riskLevel만 있으면 살아남는다', () => {
        const result = mapRowsToPriorAnalyses([
            row({ trend: 'neutral', riskLevel: 'low', actionRecommendation: {} }),
        ]);

        expect(result).toEqual([
            {
                generatedAt: expect.any(Date),
                trend: 'neutral',
                riskLevel: 'low',
            },
        ]);
        expect(result[0]).not.toHaveProperty('entryPrices');
        expect(result[0]).not.toHaveProperty('stopLoss');
        expect(result[0]).not.toHaveProperty('takeProfitPrices');
    });

    it('비정상(NaN/음수/문자열) 숫자는 개별적으로 드롭된다 — 행 전체를 버리지 않는다', () => {
        const result = mapRowsToPriorAnalyses([
            row({
                trend: 'bearish',
                riskLevel: 'high',
                actionRecommendation: {
                    entryPrices: [0, -5, 'x', 150],
                    stopLoss: -1,
                    takeProfitPrices: [0, -3],
                },
            }),
        ]);

        expect(result).toEqual([
            {
                generatedAt: expect.any(Date),
                trend: 'bearish',
                riskLevel: 'high',
                entryPrices: [150],
            },
        ]);
    });

    it('model_id로 필터링하지 않는다 — 행에 modelId가 있든 없든, 어떤 값이든 전부 포함한다', () => {
        const rows = [
            { ...row({ trend: 'bullish', riskLevel: 'low' }), modelId: 'claude-sonnet-4' } as any,
            {
                ...row({ trend: 'bearish', riskLevel: 'high' }),
                modelId: 'deepseek-v4-flash',
            } as any,
        ];

        expect(mapRowsToPriorAnalyses(rows)).toHaveLength(2);
    });

    it('여러 행을 순서대로 매핑한다', () => {
        const rows = [
            row({ trend: 'bullish', riskLevel: 'low' }, new Date('2026-05-24T09:00:00.000Z')),
            row({ trend: 'bearish', riskLevel: 'high' }, new Date('2026-05-24T08:00:00.000Z')),
        ];

        const result = mapRowsToPriorAnalyses(rows);
        expect(result).toHaveLength(2);
        expect(result[0]!.trend).toBe('bullish');
        expect(result[1]!.trend).toBe('bearish');
    });
});
