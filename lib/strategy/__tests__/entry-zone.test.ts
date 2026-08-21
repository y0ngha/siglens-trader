import { describe, it, expect } from 'vitest';
import {
    ENTRY_ZONE_TOLERANCE,
    exceedsEntryZone,
    formatEntryZone,
    formatStopRoom,
    hasStopRoom,
    MIN_STOP_ROOM,
} from '../entry-zone.js';
import { SUPPORT_BREAK_BUFFER } from '../risk-manager.js';

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

describe('hasStopRoom', () => {
    const BUF = SUPPORT_BREAK_BUFFER;

    describe('happy path', () => {
        it('손절선이 충분히 아래면 통과시킨다', () => {
            expect(hasStopRoom(150, { supportLevel: 140 }, BUF)).toBe(true);
        });

        it('분석 손절가만 있어도 판단한다', () => {
            expect(hasStopRoom(150, { aiStopLoss: 140 }, BUF)).toBe(true);
            expect(hasStopRoom(150, { aiStopLoss: 149.9 }, BUF)).toBe(false);
        });
    });

    describe('실측 회귀 — 이 가드가 없어서 잃은 3건 (2026-08-19~20)', () => {
        it('PLTR 175.65 매수 / 지지 175.60 — 여유 0.03%라 막는다', () => {
            expect(hasStopRoom(175.65, { supportLevel: 175.6 }, BUF)).toBe(false);
        });

        it('TSLA 348.1372 매수 / 분석 손절 347.78 — 막는다', () => {
            expect(hasStopRoom(348.1372, { aiStopLoss: 347.78 }, BUF)).toBe(false);
        });

        it('PLTR 174.66 매수 / 지지 174.69 (진입가보다 위) — 막는다', () => {
            expect(hasStopRoom(174.66, { supportLevel: 174.69 }, BUF)).toBe(false);
        });
    });

    describe('가장 먼저 서는 트리거를 본다', () => {
        it('두 레벨 중 높은 쪽 기준이다 — 낮은 쪽을 쓰면 없는 여유를 센다', () => {
            // 지지선 트리거는 100*0.995=99.5, 분석 손절가는 149.9. 149.9가 먼저 선다.
            expect(hasStopRoom(150, { supportLevel: 100, aiStopLoss: 149.9 }, BUF)).toBe(false);
            // 순서를 바꿔도 같은 결론이어야 한다.
            expect(hasStopRoom(150, { aiStopLoss: 100, supportLevel: 149.9 }, BUF)).toBe(false);
        });

        it('지지선 버퍼가 트리거를 낮춘 만큼은 여유로 인정한다', () => {
            // 버퍼 없이 보면 트리거 100 → 101이 필요하지만, 실제 트리거는 99.5다.
            const trigger = 100 * (1 - BUF);
            expect(hasStopRoom(trigger * (1 + MIN_STOP_ROOM), { supportLevel: 100 }, BUF)).toBe(
                true,
            );
        });
    });

    describe('경계값', () => {
        it('정확히 최소 여유면 통과시킨다 (>=)', () => {
            const trigger = 100 * (1 - BUF);
            expect(hasStopRoom(trigger * (1 + MIN_STOP_ROOM), { supportLevel: 100 }, BUF)).toBe(
                true,
            );
        });

        it('최소 여유에 한 틱 못 미치면 막는다', () => {
            const trigger = 100 * (1 - BUF);
            expect(
                hasStopRoom(trigger * (1 + MIN_STOP_ROOM) - 0.01, { supportLevel: 100 }, BUF),
            ).toBe(false);
        });
    });

    describe('worst case — 판단 재료가 없거나 망가졌으면 fail-open', () => {
        it('레벨이 하나도 없으면 통과시킨다', () => {
            expect(hasStopRoom(150, {}, BUF)).toBe(true);
        });

        it('비정상 레벨은 무시한다', () => {
            expect(hasStopRoom(150, { supportLevel: NaN, aiStopLoss: undefined }, BUF)).toBe(true);
            expect(hasStopRoom(150, { supportLevel: 0 }, BUF)).toBe(true);
            expect(hasStopRoom(150, { supportLevel: -10 }, BUF)).toBe(true);
            expect(hasStopRoom(150, { supportLevel: Infinity }, BUF)).toBe(true);
        });

        it('가격이 비정상이면 통과시킨다 — 여기서 막을 문제가 아니다', () => {
            expect(hasStopRoom(NaN, { supportLevel: 140 }, BUF)).toBe(true);
            expect(hasStopRoom(0, { supportLevel: 140 }, BUF)).toBe(true);
        });

        it('버퍼·최소여유가 비정상이면 0으로 읽고 계속 판단한다', () => {
            // 가드가 조용히 통과-전용이 되면 안 된다: 트리거 자체는 여전히 본다.
            expect(hasStopRoom(139, { supportLevel: 140 }, NaN, NaN)).toBe(false);
            expect(hasStopRoom(141, { supportLevel: 140 }, NaN, NaN)).toBe(true);
        });
    });
});

describe('formatStopRoom', () => {
    it('간격과 트리거 가격을 함께 적는다', () => {
        expect(formatStopRoom(150, { supportLevel: 140 }, 0)).toBe('6.67% (트리거 $140.00)');
    });

    it('가장 먼저 서는 트리거를 표기한다', () => {
        expect(formatStopRoom(150, { supportLevel: 100, aiStopLoss: 145 }, 0)).toContain('$145.00');
    });

    it('판단 재료가 없으면 undefined', () => {
        expect(formatStopRoom(150, {}, 0)).toBeUndefined();
        expect(formatStopRoom(NaN, { supportLevel: 140 }, 0)).toBeUndefined();
    });
});
