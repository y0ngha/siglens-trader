import { describe, expect, it } from 'vitest';
import { EARNINGS_EVENT_LOOKBACK_DAYS, earningsToMarketEvents } from '../earnings-events';

const NOW = new Date('2026-09-25T20:00:00Z');

describe('earningsToMarketEvents', () => {
    describe('변환', () => {
        it('최근 발표일을 earnings·neutral·high 이벤트로, 발표일 12:00 UTC에 둔다', () => {
            expect(earningsToMarketEvents(['2026-09-24'], NOW)).toEqual([
                {
                    publishedAt: new Date('2026-09-24T12:00:00Z'),
                    category: 'earnings',
                    sentiment: 'neutral',
                    impact: 'high',
                },
            ]);
        });

        it('오늘·내일 발표도 포함한다(장 후 발표 다음 날의 급락을 잡기 위해)', () => {
            expect(earningsToMarketEvents(['2026-09-25', '2026-09-26'], NOW)).toHaveLength(2);
        });
    });

    describe('제외', () => {
        it(`${EARNINGS_EVENT_LOOKBACK_DAYS}일보다 오래된 발표와 모레 이후 예정은 버린다`, () => {
            expect(earningsToMarketEvents(['2026-09-14', '2026-09-28'], NOW)).toEqual([]);
        });

        it('형식이 어긋난 날짜는 버린다', () => {
            expect(earningsToMarketEvents(['2026/09/24', 'bad', ''], NOW)).toEqual([]);
        });

        it('빈 입력은 빈 배열', () => {
            expect(earningsToMarketEvents([], NOW)).toEqual([]);
        });
    });
});
