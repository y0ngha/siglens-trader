import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from 'react-error-boundary';
import { App } from './App';
import './index.css';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            refetchInterval: 10_000,
            retry: 1,
            staleTime: 5_000,
        },
    },
});

function ErrorFallback({ error }: { error: unknown }) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return (
        <div className="flex min-h-dvh items-center justify-center p-4">
            <div className="max-w-sm text-center">
                <p className="text-lg font-semibold text-red-400">오류 발생</p>
                <p className="mt-2 text-sm text-neutral-400">{message}</p>
                <button
                    onClick={() => window.location.reload()}
                    className="mt-4 rounded-lg bg-neutral-800 px-4 py-2 text-sm"
                >
                    새로고침
                </button>
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ErrorBoundary FallbackComponent={ErrorFallback}>
            <QueryClientProvider client={queryClient}>
                <App />
            </QueryClientProvider>
        </ErrorBoundary>
    </StrictMode>,
);
