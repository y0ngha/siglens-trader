import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollUntilDone } from '../poll-until-done';

describe('pollUntilDone', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('returns result immediately when poll returns done', async () => {
        const pollFn = vi.fn().mockResolvedValue({ status: 'done', result: { score: 85 } });

        const promise = pollUntilDone(pollFn, 'job-1');
        await vi.runAllTimersAsync();
        const outcome = await promise;

        expect(outcome).toEqual({ result: { score: 85 } });
        expect(pollFn).toHaveBeenCalledTimes(1);
        expect(pollFn).toHaveBeenCalledWith('job-1');
    });

    it('polls multiple times until done', async () => {
        const pollFn = vi
            .fn()
            .mockResolvedValueOnce({ status: 'processing' })
            .mockResolvedValueOnce({ status: 'processing' })
            .mockResolvedValueOnce({ status: 'done', result: { score: 90 } });

        const promise = pollUntilDone(pollFn, 'job-2');
        await vi.runAllTimersAsync();
        const outcome = await promise;

        expect(outcome).toEqual({ result: { score: 90 } });
        expect(pollFn).toHaveBeenCalledTimes(3);
    });

    it('returns error when poll returns error status', async () => {
        const pollFn = vi.fn().mockResolvedValue({ status: 'error', error: 'Model rate limited' });

        const promise = pollUntilDone(pollFn, 'job-3');
        await vi.runAllTimersAsync();
        const outcome = await promise;

        expect(outcome).toEqual({ error: 'Model rate limited' });
    });

    it('returns "Unknown error" when error status has no message', async () => {
        const pollFn = vi.fn().mockResolvedValue({ status: 'error' });

        const promise = pollUntilDone(pollFn, 'job-4');
        await vi.runAllTimersAsync();
        const outcome = await promise;

        expect(outcome).toEqual({ error: 'Unknown error' });
    });

    it('returns timeout error when deadline exceeded', async () => {
        let callCount = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => {
            callCount++;
            // First call sets deadline (0 + 600_000 = 600_000)
            // Second call checks loop condition — return past deadline
            return callCount === 1 ? 0 : 700_000;
        });

        const pollFn = vi.fn().mockResolvedValue({ status: 'processing' });

        const promise = pollUntilDone(pollFn, 'job-5');
        await vi.runAllTimersAsync();
        const outcome = await promise;

        expect(outcome).toEqual({ error: 'Poll timeout exceeded' });
        // pollFn should never be called because Date.now() > deadline on first loop check
        expect(pollFn).not.toHaveBeenCalled();
    });

    it('keeps polling when status is done but result is null', async () => {
        const pollFn = vi
            .fn()
            .mockResolvedValueOnce({ status: 'done', result: null })
            .mockResolvedValueOnce({ status: 'done', result: undefined })
            .mockResolvedValueOnce({ status: 'done', result: { data: 'ok' } });

        const promise = pollUntilDone(pollFn, 'job-6');
        await vi.runAllTimersAsync();
        const outcome = await promise;

        expect(outcome).toEqual({ result: { data: 'ok' } });
        expect(pollFn).toHaveBeenCalledTimes(3);
    });
});
