import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';

/**
 * Optimistic mutation helper.
 *
 * Applies `updater` to the cached query data immediately (before the request
 * resolves) so the UI reacts instantly, then rolls back on error and
 * re-syncs with the server on settle. This is the shared pattern for every
 * DB-backed action in the dashboard (watchlist, settings, position close,
 * alert dismiss, …) so they all feel instant instead of waiting on a refetch.
 *
 * Per-call `onSuccess`/`onError` passed to `.mutate(vars, { ... })` still run
 * (React Query merges hook-level and call-level callbacks), so callers can
 * layer feedback messages on top of the optimistic update.
 */
export function useOptimisticMutation<TVars, TCache, TData = unknown>({
    mutationFn,
    queryKey,
    updater,
    onSuccess,
    onError,
}: {
    mutationFn: (vars: TVars) => Promise<TData>;
    queryKey: QueryKey;
    updater: (previous: TCache | undefined, vars: TVars) => TCache | undefined;
    onSuccess?: (data: TData, vars: TVars) => void;
    onError?: (error: Error, vars: TVars) => void;
}) {
    const queryClient = useQueryClient();
    return useMutation<TData, Error, TVars, { previous: TCache | undefined }>({
        mutationFn,
        onMutate: async (vars) => {
            // Cancel in-flight refetches so they don't clobber the optimistic value.
            await queryClient.cancelQueries({ queryKey });
            const previous = queryClient.getQueryData<TCache>(queryKey);
            queryClient.setQueryData<TCache>(queryKey, (old) => updater(old, vars));
            return { previous };
        },
        onError: (error, vars, context) => {
            // Roll back to the snapshot captured in onMutate.
            queryClient.setQueryData<TCache>(queryKey, context?.previous);
            onError?.(error, vars);
        },
        onSuccess,
        onSettled: () => queryClient.invalidateQueries({ queryKey }),
    });
}
