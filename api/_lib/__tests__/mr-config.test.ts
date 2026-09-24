import { describe, it, expect, vi } from 'vitest';

const mockGetConfigValue = vi.fn();
vi.mock('../../../lib/db/queries', () => ({
    getConfigValue: (...args: unknown[]) => mockGetConfigValue(...args),
}));

import { readMrParams, readDryRunCostBps, DEFAULT_DRY_RUN_COST_BPS } from '../mr-config';
import { DEFAULT_MR_PARAMS } from '../../../lib/strategy/mean-reversion';
import type { Db } from '../../../lib/db/index';

const db = {} as Db;
const stored = (values: Record<string, unknown>) =>
    mockGetConfigValue.mockImplementation(async (_db: Db, key: string) => values[key] ?? null);

describe('readMrParams', () => {
    it('reads stored values', async () => {
        stored({ mr_rsi_entry: 5, mr_max_hold_days: 7, mr_stop_atr: 0, mr_regime_filter: false });
        expect(await readMrParams(db)).toEqual({
            rsiEntry: 5,
            maxHoldDays: 7,
            stopAtr: 0,
            regimeFilter: false,
        });
    });

    it('falls back to defaults for missing, out-of-range or mistyped rows', async () => {
        stored({
            mr_rsi_entry: 99,
            mr_max_hold_days: '7',
            mr_stop_atr: -1,
            mr_regime_filter: 'no',
        });
        expect(await readMrParams(db)).toEqual(DEFAULT_MR_PARAMS);
        stored({});
        expect(await readMrParams(db)).toEqual(DEFAULT_MR_PARAMS);
    });

    it('rounds a fractional hold count', async () => {
        stored({ mr_max_hold_days: 7.4 });
        expect((await readMrParams(db)).maxHoldDays).toBe(7);
    });

    // 거부 목은 각 테스트가 직접 건다(beforeEach 없이). beforeEach 훅이 있는 describe 안에서
    // `mockRejectedValue`를 쓰면 vitest가 코드가 잡은 거부까지 테스트 실패로 표시했다(반환값은
    // 정상 기본값) — 원인은 확인하지 못했고, 훅을 없애면 사라진다.
    it('survives a failing read', async () => {
        mockGetConfigValue.mockRejectedValue(new Error('db down'));
        expect(await readMrParams(db)).toEqual(DEFAULT_MR_PARAMS);
    });
});

describe('readDryRunCostBps', () => {
    it('reads a stored value and defaults otherwise', async () => {
        stored({ dry_run_cost_bps: 25 });
        expect(await readDryRunCostBps(db)).toBe(25);
        stored({ dry_run_cost_bps: 500 });
        expect(await readDryRunCostBps(db)).toBe(DEFAULT_DRY_RUN_COST_BPS);
    });

    it('defaults on a failing read', async () => {
        mockGetConfigValue.mockRejectedValue(new Error('x'));
        expect(await readDryRunCostBps(db)).toBe(10);
    });
});
