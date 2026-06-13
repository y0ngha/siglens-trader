const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_TIME_MS = 300_000;

export async function pollUntilDone<T>(
    pollFn: (jobId: string) => Promise<{ status: string; result?: T; error?: string }>,
    jobId: string,
): Promise<{ result: T } | { error: string }> {
    const deadline = Date.now() + MAX_POLL_TIME_MS;

    while (Date.now() < deadline) {
        const response = await pollFn(jobId);

        if (response.status === 'done' && response.result) {
            return { result: response.result };
        }
        if (response.status === 'error') {
            return { error: response.error ?? 'Unknown error' };
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    return { error: 'Poll timeout exceeded' };
}
