import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VersionBadge } from '../VersionBadge';

function renderBadge() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={queryClient}>
            <VersionBadge />
        </QueryClientProvider>,
    );
}

/** `/api/health`가 주는 서버 버전. */
function mockHealth(version: unknown, ok = true) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, json: async () => ({ version }) }));
}

describe('VersionBadge', () => {
    beforeEach(() => {
        // `__APP_VERSION__`은 vite `define`이 박는 값이라 테스트에서는 직접 세운다.
        vi.stubGlobal('__APP_VERSION__', '1.2.3');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('번들 버전은 서버 응답 없이도 바로 뜬다', () => {
        mockHealth('1.2.3');
        renderBadge();
        expect(screen.getByText(/앱 1\.2\.3/)).toBeInTheDocument();
    });

    it('서버 버전이 오면 함께 보여준다', async () => {
        mockHealth('1.2.3');
        renderBadge();
        await waitFor(() => expect(screen.getByText(/서버 1\.2\.3/)).toBeInTheDocument());
    });

    it('두 버전이 다르면 새로고침 안내를 띄운다 — 이 컴포넌트의 존재 이유', async () => {
        // 새 서버에 옛 번들이 캐시로 붙어 있는 상태. 서버 버전만 봤다면 배포가
        // 반영됐다고 오인한다.
        mockHealth('1.3.0');
        renderBadge();
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('새로고침 필요'));
    });

    it('버전이 같으면 안내를 띄우지 않는다', async () => {
        mockHealth('1.2.3');
        renderBadge();
        await waitFor(() => expect(screen.getByText(/서버 1\.2\.3/)).toBeInTheDocument());
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it("서버가 'unknown'이면 불일치로 보지 않는다 — 모른다와 다르다는 다르다", async () => {
        mockHealth('unknown');
        renderBadge();
        await waitFor(() => expect(screen.getByText(/서버 unknown/)).toBeInTheDocument());
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('헬스 조회가 실패해도 번들 버전은 남는다', async () => {
        mockHealth(null, false);
        renderBadge();
        expect(screen.getByText(/앱 1\.2\.3/)).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByText(/서버/)).not.toBeInTheDocument());
    });

    it('네트워크 오류에도 깨지지 않는다', async () => {
        vi.stubGlobal('__APP_VERSION__', '1.2.3');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        renderBadge();
        expect(screen.getByText(/앱 1\.2\.3/)).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    });
});
