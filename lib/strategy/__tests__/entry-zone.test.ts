import { describe, it, expect } from 'vitest';
import { ENTRY_ZONE_TOLERANCE, exceedsEntryZone, formatEntryZone } from '../entry-zone.js';

describe('exceedsEntryZone', () => {
    it('구간 안이면 통과시킨다', () => {
        expect(exceedsEntryZone(150, [148, 152])).toBe(false);
    });

    it('구간 상단을 크게 넘어서면 막는다 — 이 게이트의 존재 이유', () => {
        // 분석은 $150 진입을 말했는데 다음 틱에 $180. 점수는 아직 매수 신호일 수 있다.
        expect(exceedsEntryZone(180, [148, 152])).toBe(true);
    });

    it('구간 아래는 막지 않는다 — 상단만 본다', () => {
        expect(exceedsEntryZone(120, [148, 152])).toBe(false);
        expect(exceedsEntryZone(0.01, [148, 152])).toBe(false);
    });

    it('허용 오차 안쪽은 통과, 바깥은 차단', () => {
        const ceiling = 152 * (1 + ENTRY_ZONE_TOLERANCE);
        expect(exceedsEntryZone(ceiling, [148, 152])).toBe(false);
        expect(exceedsEntryZone(ceiling + 0.01, [148, 152])).toBe(true);
    });

    it('구간이 비었거나 없으면 통과시킨다 (fail-open)', () => {
        expect(exceedsEntryZone(180, [])).toBe(false);
        expect(exceedsEntryZone(180, undefined)).toBe(false);
    });

    it('비정상 값은 무시하고 남은 값으로 판정한다', () => {
        expect(exceedsEntryZone(180, [NaN, Infinity, -5, 0, 150])).toBe(true);
        expect(exceedsEntryZone(151, [NaN, Infinity, -5, 0, 150])).toBe(false);
    });

    it('구간이 전부 비정상이면 판단하지 않는다', () => {
        expect(exceedsEntryZone(180, [NaN, -1, 0])).toBe(false);
    });

    it('현재가가 비정상이면 막지 않는다 — 가격 가드는 별도로 있다', () => {
        for (const p of [0, -1, NaN, Infinity]) {
            expect(exceedsEntryZone(p, [150])).toBe(false);
        }
    });

    it('허용 오차를 직접 넘길 수 있고, 비정상 오차는 0으로 본다', () => {
        expect(exceedsEntryZone(160, [150], 0.1)).toBe(false);
        expect(exceedsEntryZone(166, [150], 0.1)).toBe(true);
        expect(exceedsEntryZone(150.5, [150], NaN)).toBe(true);
        expect(exceedsEntryZone(150.5, [150], -1)).toBe(true);
    });
});

describe('formatEntryZone', () => {
    it('범위를 사람이 읽는 형태로 낸다', () => {
        expect(formatEntryZone([152, 148])).toBe('$148 ~ $152');
    });

    it('값이 하나면 단일 가격으로 낸다', () => {
        expect(formatEntryZone([150])).toBe('$150');
        expect(formatEntryZone([150, 150])).toBe('$150');
    });

    it('쓸 값이 없으면 undefined', () => {
        expect(formatEntryZone([])).toBeUndefined();
        expect(formatEntryZone(undefined)).toBeUndefined();
        expect(formatEntryZone([NaN, -1])).toBeUndefined();
    });
});
