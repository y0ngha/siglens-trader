import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from 'react-error-boundary';
import { App } from './App';
import { ErrorFallback } from './components/ErrorFallback';
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

async function startApp() {
    if (import.meta.env.VITE_API_MOCK === 'true') {
        const { worker } = await import('./mocks/browser');
        await worker.start({
            onUnhandledRequest: 'bypass',
        });
        console.log('[MSW] Mock enabled');
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
}

startApp();
