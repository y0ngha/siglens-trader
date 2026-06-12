import { describe, it, expect } from 'vitest';
import { makeEmailGate } from '../gate';

describe('makeEmailGate', () => {
    it('returns false for every event when config is undefined (no row)', () => {
        const gate = makeEmailGate(undefined);
        expect(gate('trade_executed')).toBe(false);
        expect(gate('error')).toBe(false);
        expect(gate()).toBe(false);
    });

    it('returns false for all events when the channel is disabled', () => {
        const gate = makeEmailGate({ enabled: false, events: ['trade_executed', 'error'] });
        expect(gate('trade_executed')).toBe(false);
        expect(gate('error')).toBe(false);
    });

    it('returns true only for selected events when enabled', () => {
        const gate = makeEmailGate({ enabled: true, events: ['trade_executed'] });
        expect(gate('trade_executed')).toBe(true);
        expect(gate('order_pending')).toBe(false);
    });

    it('returns true if ANY of the given event keys is selected (alias support)', () => {
        const gate = makeEmailGate({ enabled: true, events: ['approval_required'] });
        expect(gate('order_pending', 'approval_required')).toBe(true);
        expect(gate('order_pending')).toBe(false);
    });

    it('returns false when called with no event keys', () => {
        const gate = makeEmailGate({ enabled: true, events: ['error'] });
        expect(gate()).toBe(false);
    });
});
