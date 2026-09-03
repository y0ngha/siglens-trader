import { describe, it, expect } from 'vitest';
import {
    ENTRY_ZONE_TOLERANCE,
    exceedsEntryZone,
    formatEntryZone,
    firstUpsideExit,
    formatRiskReward,
    formatStopRoom,
    hasRiskReward,
    hasStopRoom,
    MIN_RISK_REWARD,
    MIN_STOP_ROOM,
    riskRewardRatio,
} from '../entry-zone.js';

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
    describe('happy path', () => {
        it('손절 레벨이 충분히 아래면 통과시킨다', () => {
            expect(hasStopRoom(150, { supportLevel: 140 })).toBe(true);
        });

        it('분석 손절가만 있어도 판단한다', () => {
            expect(hasStopRoom(150, { aiStopLoss: 140 })).toBe(true);
            expect(hasStopRoom(150, { aiStopLoss: 149.9 })).toBe(false);
        });
    });

    describe('실측 회귀 — 이 가드가 없어서 잃은 3건 (2026-08-19~20)', () => {
        it('PLTR 175.65 매수 / 지지 175.60 — 여유 0.03%라 막는다', () => {
            expect(hasStopRoom(175.65, { supportLevel: 175.6 })).toBe(false);
        });

        it('TSLA 348.1372 매수 / 분석 손절 347.78 — 막는다', () => {
            expect(hasStopRoom(348.1372, { aiStopLoss: 347.78 })).toBe(false);
        });

        it('PLTR 174.66 매수 / 지지 174.69 (진입가보다 위) — 막는다', () => {
            expect(hasStopRoom(174.66, { supportLevel: 174.69 })).toBe(false);
        });
    });

    describe('기본값 보정 — 게이트도 정지 버튼도 되지 않아야 한다', () => {
        it('기본값은 0.5%다', () => {
            expect(MIN_STOP_ROOM).toBe(0.005);
        });

        it('실측 실패 3건을 전부 기본값으로 막는다', () => {
            // 아래 경계: 관측된 최악(0.03%)보다 넉넉히 위여야 한다.
            expect(hasStopRoom(175.65, { supportLevel: 175.6 }, MIN_STOP_ROOM)).toBe(false);
            expect(hasStopRoom(348.1372, { aiStopLoss: 347.78 }, MIN_STOP_ROOM)).toBe(false);
            expect(hasStopRoom(174.66, { supportLevel: 174.69 }, MIN_STOP_ROOM)).toBe(false);
        });

        it('core의 ATR 폴백 손절(진입가 − 1.5×ATR)이 확보하는 여유는 통과시킨다', () => {
            // 위 경계: 1%로 잡으면 ATR이 가격의 0.667% 미만인 종목이 영구 차단된다.
            // 0.5%면 ATR ≥ 0.333%부터 통과하므로 30분봉에서도 정상 종목이 살아남는다.
            const price = 175;
            for (const atrPct of [0.004, 0.006, 0.01]) {
                const stop = price - 1.5 * atrPct * price;
                expect(hasStopRoom(price, { aiStopLoss: stop })).toBe(true);
            }
            // ATR이 정말로 미미하면(0.2%) 여전히 막는다 — 그게 이 가드의 목적이다.
            expect(hasStopRoom(price, { aiStopLoss: price - 1.5 * 0.002 * price })).toBe(false);
        });
    });

    describe('가장 먼저 서는 레벨을 본다', () => {
        it('두 레벨 중 높은 쪽 기준이다 — 낮은 쪽을 쓰면 없는 여유를 센다', () => {
            expect(hasStopRoom(150, { supportLevel: 100, aiStopLoss: 149.9 })).toBe(false);
            // 순서를 바꿔도 같은 결론이어야 한다.
            expect(hasStopRoom(150, { aiStopLoss: 100, supportLevel: 149.9 })).toBe(false);
        });
    });

    describe('경계값', () => {
        it('정확히 최소 여유면 통과시킨다 (>=)', () => {
            expect(hasStopRoom(100 * (1 + MIN_STOP_ROOM), { supportLevel: 100 })).toBe(true);
        });

        it('최소 여유에 한 틱 못 미치면 막는다', () => {
            expect(hasStopRoom(100 * (1 + MIN_STOP_ROOM) - 0.01, { supportLevel: 100 })).toBe(
                false,
            );
        });

        it('minRoom 0이면 가드가 꺼진다 — 레벨 위이기만 하면 통과', () => {
            expect(hasStopRoom(100.01, { supportLevel: 100 }, 0)).toBe(true);
            expect(hasStopRoom(99.99, { supportLevel: 100 }, 0)).toBe(false);
        });
    });

    describe('worst case — 판단 재료가 없거나 망가졌으면 fail-open', () => {
        it('레벨이 하나도 없으면 통과시킨다', () => {
            expect(hasStopRoom(150, {})).toBe(true);
        });

        it('비정상 레벨은 무시한다', () => {
            expect(hasStopRoom(150, { supportLevel: NaN, aiStopLoss: undefined })).toBe(true);
            expect(hasStopRoom(150, { supportLevel: 0 })).toBe(true);
            expect(hasStopRoom(150, { supportLevel: -10 })).toBe(true);
            expect(hasStopRoom(150, { supportLevel: Infinity })).toBe(true);
        });

        it('둘 중 하나만 비정상이면 나머지로 판단한다', () => {
            expect(hasStopRoom(150, { supportLevel: NaN, aiStopLoss: 149.9 })).toBe(false);
            expect(hasStopRoom(150, { supportLevel: 149.9, aiStopLoss: NaN })).toBe(false);
        });

        it('가격이 비정상이면 통과시킨다 — 여기서 막을 문제가 아니다', () => {
            expect(hasStopRoom(NaN, { supportLevel: 140 })).toBe(true);
            expect(hasStopRoom(0, { supportLevel: 140 })).toBe(true);
        });

        it('minRoom이 비정상이면 기본값으로 되돌린다 — 조용히 꺼지지 않는다', () => {
            // 설정 행이 망가졌을 때 가드가 통과-전용이 되면 이 가드가 없는 것과 같다.
            expect(hasStopRoom(175.65, { supportLevel: 175.6 }, NaN)).toBe(false);
            expect(hasStopRoom(175.65, { supportLevel: 175.6 }, -1)).toBe(false);
            expect(hasStopRoom(150, { supportLevel: 140 }, NaN)).toBe(true);
        });
    });
});

describe('formatStopRoom', () => {
    it('간격과 손절 레벨을 함께 적는다', () => {
        expect(formatStopRoom(150, { supportLevel: 140 })).toBe('6.67% (손절 레벨 $140.00)');
    });

    it('가장 먼저 서는 레벨을 표기한다', () => {
        expect(formatStopRoom(150, { supportLevel: 100, aiStopLoss: 145 })).toBe(
            '3.33% (손절 레벨 $145.00)',
        );
    });

    it('가격이 레벨 아래면 음수로 적는다 — 감사에서 그 상황이 보여야 한다', () => {
        expect(formatStopRoom(174.66, { supportLevel: 174.69 })).toBe('-0.02% (손절 레벨 $174.69)');
    });

    it('판단 재료가 없으면 undefined', () => {
        expect(formatStopRoom(150, {})).toBeUndefined();
        expect(formatStopRoom(NaN, { supportLevel: 140 })).toBeUndefined();
        expect(formatStopRoom(150, { supportLevel: NaN })).toBeUndefined();
    });
});

describe('firstUpsideExit', () => {
    it('가장 먼저 서는 익절 트리거를 고른다 — 더 먼 목표를 세면 못 먹을 이익을 센다', () => {
        // 목표가는 95%에서 발동한다. 저항은 `takeProfit`이 있으면 후보가 아니다(아래 참고).
        expect(firstUpsideExit(100, { takeProfit: 130, target: 120 })).toBeCloseTo(
            114, // 120 × 0.95
        );
    });

    it('저항선은 takeProfit이 없을 때만 후보다 — 규칙 5가 4.5의 폴백이라서', () => {
        // takeProfit이 있으면 청산 체인의 규칙 5(저항 밴드)는 아예 서지 않는다. 여기서
        // 세면 서지도 않을 트리거를 보상 상한으로 잡아 손익비를 실제보다 낮게 낸다.
        expect(firstUpsideExit(100, { takeProfit: 110, resistance: 105 })).toBeCloseTo(110);
        // 없으면 폴백이 살아나 밴드 하단(−2%)이 보상이 된다.
        expect(firstUpsideExit(100, { resistance: 105 })).toBeCloseTo(102.9);
    });

    it('진입가 이하인 레벨은 후보에서 뺀다', () => {
        expect(firstUpsideExit(100, { takeProfit: 95, resistance: 99 })).toBeNull();
        // `takeProfit` 95는 현재가 100 **아래**라 규칙 4.5가 이미 서 있다 — 상방이 없다.
        // 종전에는 저항 120×0.98=117.6을 보상으로 셌는데, 거기 닿기 한참 전에 4.5가
        // 발동해 청산되므로 도달할 수 없는 이익이었다.
        expect(firstUpsideExit(100, { takeProfit: 95, resistance: 120 })).toBeNull();
    });

    it('레벨이 없거나 가격이 비정상이면 null', () => {
        expect(firstUpsideExit(100, {})).toBeNull();
        expect(firstUpsideExit(Number.NaN, { takeProfit: 110 })).toBeNull();
    });
});

describe('riskRewardRatio', () => {
    it('상방/하방을 실제 트리거 기준으로 계산한다', () => {
        // 하방: max(지지 90, 손절 없음) = 90 → 리스크 10
        // 상방: 익절 115 (저항 없음) → 보상 15 → R:R 1.5
        expect(riskRewardRatio(100, { takeProfit: 115, supportLevel: 90 })).toBeCloseTo(1.5);
    });

    it('하방은 먼저 서는 쪽(높은 레벨)을 쓴다', () => {
        // 지지 90 vs 분석 손절 95 → 95가 먼저 선다 → 리스크 5 → R:R 3.0
        expect(
            riskRewardRatio(100, { takeProfit: 115, supportLevel: 90, aiStopLoss: 95 }),
        ).toBeCloseTo(3.0);
    });

    it('익절 레벨이 전부 진입가 이하면 0이다 — null(판단 불가)과 구분해야 한다', () => {
        // 실측에서 매수 신호의 6/8이 이 상태였다. "먹을 게 없다"는 정보이지 무지가 아니다.
        expect(riskRewardRatio(100, { takeProfit: 95, supportLevel: 90 })).toBe(0);
        expect(riskRewardRatio(100, { resistance: 98, supportLevel: 90 })).toBe(0);
    });

    it('하방을 모르면 null — 그때는 판단하지 않는다', () => {
        expect(riskRewardRatio(100, { takeProfit: 115 })).toBeNull();
        expect(riskRewardRatio(100, { takeProfit: 115, supportLevel: 105 })).toBeNull();
    });

    it('상방 레벨이 하나도 없으면 null', () => {
        expect(riskRewardRatio(100, { supportLevel: 90 })).toBeNull();
    });

    it('가격이 비정상이면 null', () => {
        expect(riskRewardRatio(Number.NaN, { takeProfit: 115, supportLevel: 90 })).toBeNull();
        expect(riskRewardRatio(0, { takeProfit: 115, supportLevel: 90 })).toBeNull();
    });
});

describe('hasRiskReward', () => {
    it('기본 요구치는 1.5', () => {
        expect(MIN_RISK_REWARD).toBe(1.5);
        expect(hasRiskReward(100, { takeProfit: 115, supportLevel: 90 })).toBe(true); // 1.5
        expect(hasRiskReward(100, { takeProfit: 114, supportLevel: 90 })).toBe(false); // 1.4
    });

    describe('실측 회귀 — 매수 신호 자리가 이 모양이었다', () => {
        it('익절가가 진입가 아래면 막는다 (실측 매수 신호 8건 중 6건)', () => {
            // PLTR 175.05 매수 / 분석 익절 174.98 → 사는 순간 익절 조건 성립
            expect(hasRiskReward(175.05, { takeProfit: 174.98, supportLevel: 174.5 })).toBe(false);
        });

        it('상방 0.14%에 하방 0.6%인 자리를 막는다', () => {
            // PLTR 176.03 / 익절 176.17 / 지지 175.0 → R:R 0.14
            expect(hasRiskReward(176.03, { takeProfit: 176.17, supportLevel: 175.0 })).toBe(false);
        });
    });

    describe('worst case — 판단 재료가 없으면 통과 (fail-open)', () => {
        it('하방을 모르면 통과 — 다른 진입 가드와 같은 정책', () => {
            expect(hasRiskReward(100, { takeProfit: 115 })).toBe(true);
        });

        it('상방 레벨이 아예 없으면 통과', () => {
            expect(hasRiskReward(100, { supportLevel: 90 })).toBe(true);
        });

        it('minRr 0이면 게이트가 꺼진다', () => {
            expect(hasRiskReward(100, { takeProfit: 95, supportLevel: 90 }, 0)).toBe(true);
        });

        it('minRr이 비정상이면 기본값으로 되돌린다 — 조용히 꺼지지 않는다', () => {
            expect(hasRiskReward(100, { takeProfit: 114, supportLevel: 90 }, Number.NaN)).toBe(
                false,
            );
            expect(hasRiskReward(100, { takeProfit: 114, supportLevel: 90 }, -1)).toBe(false);
        });
    });
});

describe('formatRiskReward', () => {
    it('비율과 익절 지점을 함께 적는다', () => {
        expect(formatRiskReward(100, { takeProfit: 115, supportLevel: 90 })).toBe(
            '1.50 (익절 $115.00)',
        );
    });

    it('상방이 없으면 그 사실을 적는다 — 0과 미상을 구분해야 감사에서 읽힌다', () => {
        expect(formatRiskReward(100, { takeProfit: 95, supportLevel: 90 })).toContain('상방 없음');
    });

    it('판단 재료가 없으면 undefined', () => {
        expect(formatRiskReward(100, { takeProfit: 115 })).toBeUndefined();
    });
});
