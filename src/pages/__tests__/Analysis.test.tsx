import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { AnalysisPage } from '../Analysis';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
    api: {
        getAnalysis: vi.fn(),
    },
}));

const mockedApi = vi.mocked(api);

function renderWithQuery(component: React.ReactElement) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(<QueryClientProvider client={queryClient}>{component}</QueryClientProvider>);
}

describe('AnalysisPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('shows loading skeleton initially', () => {
        mockedApi.getAnalysis.mockReturnValue(new Promise(() => {}));
        renderWithQuery(<AnalysisPage />);
        expect(screen.getByLabelText('로딩 중')).toBeInTheDocument();
    });

    it('displays analysis entries grouped by symbol', async () => {
        mockedApi.getAnalysis.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                type: 'technical',
                result: JSON.stringify({ signal: 'bullish' }),
                createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
            },
            {
                id: 2,
                symbol: 'AAPL',
                type: 'news',
                result: JSON.stringify({ signal: 'neutral' }),
                createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            },
            {
                id: 3,
                symbol: 'TSLA',
                type: 'technical',
                result: JSON.stringify({ signal: 'bearish' }),
                createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
            },
        ]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('분석 결과')).toBeInTheDocument();
        });

        expect(screen.getByText('AAPL')).toBeInTheDocument();
        expect(screen.getByText('TSLA')).toBeInTheDocument();
        expect(screen.getAllByText('기술적')).toHaveLength(2);
        expect(screen.getByText('뉴스')).toBeInTheDocument();
        expect(screen.getByText('Bullish')).toBeInTheDocument();
        expect(screen.getByText('Bearish')).toBeInTheDocument();
    });

    it('shows empty state when no analysis data', async () => {
        mockedApi.getAnalysis.mockResolvedValue([]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('분석 결과가 없습니다')).toBeInTheDocument();
        });
    });

    it('shows error message on failure', async () => {
        mockedApi.getAnalysis.mockRejectedValue(new Error('Failed to fetch'));

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByRole('alert')).toBeInTheDocument();
        });

        expect(screen.getByText('오류: Failed to fetch')).toBeInTheDocument();
    });

    it('handles malformed result JSON gracefully', async () => {
        mockedApi.getAnalysis.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                type: 'technical',
                result: 'not valid json',
                createdAt: new Date().toISOString(),
            },
        ]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        expect(screen.getByText('Neutral')).toBeInTheDocument();
    });
});
