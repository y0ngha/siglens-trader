import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PositionsPage } from '../Positions';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
    api: {
        getPositions: vi.fn(),
    },
}));

const mockedApi = vi.mocked(api);

function renderWithQuery(component: React.ReactElement) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(<QueryClientProvider client={queryClient}>{component}</QueryClientProvider>);
}

describe('PositionsPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('shows loading skeleton initially', () => {
        mockedApi.getPositions.mockReturnValue(new Promise(() => {}));
        renderWithQuery(<PositionsPage />);
        expect(screen.getByLabelText('로딩 중')).toBeInTheDocument();
    });

    it('displays positions when loaded', async () => {
        mockedApi.getPositions.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                side: 'long',
                quantity: 10,
                avgPrice: '150.50',
                openedAt: '2026-05-20T10:00:00Z',
                status: 'open',
            },
            {
                id: 2,
                symbol: 'TSLA',
                side: 'short',
                quantity: 5,
                avgPrice: '200.00',
                openedAt: '2026-05-21T14:00:00Z',
                status: 'open',
            },
        ]);

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByText('포지션')).toBeInTheDocument();
        });

        expect(screen.getByText('AAPL')).toBeInTheDocument();
        expect(screen.getByText('롱')).toBeInTheDocument();
        expect(screen.getByText('10')).toBeInTheDocument();
        expect(screen.getByText('$150.50')).toBeInTheDocument();

        expect(screen.getByText('TSLA')).toBeInTheDocument();
        expect(screen.getByText('숏')).toBeInTheDocument();
        expect(screen.getByText('5')).toBeInTheDocument();
        expect(screen.getByText('$200.00')).toBeInTheDocument();
    });

    it('shows empty state when no positions', async () => {
        mockedApi.getPositions.mockResolvedValue([]);

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByText('활성 포지션이 없습니다')).toBeInTheDocument();
        });
    });

    it('shows error message on failure', async () => {
        mockedApi.getPositions.mockRejectedValue(new Error('Server down'));

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByRole('alert')).toBeInTheDocument();
        });

        expect(screen.getByText('오류: Server down')).toBeInTheDocument();
    });
});
