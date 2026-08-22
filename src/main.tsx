import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from 'react-error-boundary';
import { App } from './App';
import { ErrorFallback } from './components/ErrorFallback';
import { clearChunkRecoveryFlag, installChunkRecovery } from './lib/chunk-recovery';
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

// 앱 렌더보다 먼저 — 첫 청크가 실패하면 `startApp`이 끝나기도 전에 오류가 난다.
installChunkRecovery();

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

    // 여기까지 왔으면 이 문서는 온전하다. 표식을 지워 다음 배포에서 다시 한 번
    // 복구할 수 있게 한다.
    clearChunkRecoveryFlag();
}

startApp();
