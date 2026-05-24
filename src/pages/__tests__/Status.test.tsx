import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { StatusPage } from '../Status';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
    api: {
        getStatus: vi.fn(),
    },
}));

const mockedApi = vi.mocked(api);

function renderWithQuery(component: React.ReactElement) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(<QueryClientProvider client={queryClient}>{component}</QueryClientProvider>);
}

describe('StatusPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('shows loading skeleton initially', () => {
        mockedApi.getStatus.mockReturnValue(new Promise(() => {}));
        renderWithQuery(<StatusPage />);
        expect(screen.getByLabelText('로딩 중')).toBeInTheDocument();
    });

    it('displays status data when loaded', async () => {
        mockedApi.getStatus.mockResolvedValue({
            running: true,
            tradingMode: 'paper',
            activePositions: 3,
            todayTrades: 7,
        });

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('시스템 상태')).toBeInTheDocument();
        });

        expect(screen.getByText('실행 중')).toBeInTheDocument();
        expect(screen.getByText('모의투자')).toBeInTheDocument();
        expect(screen.getByText('3')).toBeInTheDocument();
        expect(screen.getByText('7')).toBeInTheDocument();
    });

    it('displays stopped state correctly', async () => {
        mockedApi.getStatus.mockResolvedValue({
            running: false,
            tradingMode: 'auto',
            activePositions: 0,
            todayTrades: 0,
        });

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('정지')).toBeInTheDocument();
        });

        expect(screen.getByText('자동')).toBeInTheDocument();
    });

    it('displays semi-auto mode label', async () => {
        mockedApi.getStatus.mockResolvedValue({
            running: true,
            tradingMode: 'semi-auto',
            activePositions: 1,
            todayTrades: 2,
        });

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('반자동')).toBeInTheDocument();
        });
    });

    it('shows error message on failure', async () => {
        mockedApi.getStatus.mockRejectedValue(new Error('Network error'));

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByRole('alert')).toBeInTheDocument();
        });

        expect(screen.getByText('오류: Network error')).toBeInTheDocument();
    });
});
