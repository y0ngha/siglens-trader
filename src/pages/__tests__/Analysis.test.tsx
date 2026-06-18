import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { AnalysisPage } from '../Analysis';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
    api: {
        getAnalysis: vi.fn(),
        getConfig: vi.fn(),
        triggerAnalysis: vi.fn(),
    },
}));

const mockedApi = vi.mocked(api);

function mockTimeframe(value: string) {
    mockedApi.getConfig.mockResolvedValue({
        config: [{ key: 'analysis_timeframe', value }],
    } as never);
}

function renderWithQuery(component: React.ReactElement) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(<QueryClientProvider client={queryClient}>{component}</QueryClientProvider>);
}

describe('AnalysisPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockTimeframe('1Hour');
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
                analysisType: 'technical',
                result: JSON.stringify({ signal: 'bullish' }),
                createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
            },
            {
                id: 2,
                symbol: 'AAPL',
                analysisType: 'news',
                result: JSON.stringify({ signal: 'neutral' }),
                createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            },
            {
                id: 3,
                symbol: 'TSLA',
                analysisType: 'technical',
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
        expect(screen.getByText('강세')).toBeInTheDocument();
        expect(screen.getByText('약세')).toBeInTheDocument();
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
                analysisType: 'technical',
                result: 'not valid json',
                createdAt: new Date().toISOString(),
            },
        ]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        expect(screen.getByText('중립')).toBeInTheDocument();
    });

    // --- Staleness indicator tests ---

    it('shows "오래됨" badge for stale analysis (older than 4 hours)', async () => {
        mockedApi.getAnalysis.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                analysisType: 'technical',
                result: JSON.stringify({ signal: 'bullish' }),
                createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
            },
        ]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('오래됨')).toBeInTheDocument();
        });
    });

    it('does not show "오래됨" badge for fresh analysis (less than 4 hours)', async () => {
        mockedApi.getAnalysis.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                analysisType: 'technical',
                result: JSON.stringify({ signal: 'bullish' }),
                createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
            },
        ]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        expect(screen.queryByText('오래됨')).not.toBeInTheDocument();
    });

    it('uses yellow border for stale analysis group', async () => {
        mockedApi.getAnalysis.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                analysisType: 'technical',
                result: JSON.stringify({ signal: 'bullish' }),
                createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
            },
        ]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        const listItem = screen.getByText('AAPL').closest('li');
        expect(listItem).toHaveClass('border-yellow-500/30');
    });

    it('uses sourceAnalyzedAt before fresh analyzedAt and createdAt for display and staleness', async () => {
        mockedApi.getAnalysis.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                analysisType: 'technical',
                result: JSON.stringify({ signal: 'bullish' }),
                createdAt: new Date().toISOString(),
                analyzedAt: new Date().toISOString(),
                sourceAnalyzedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
            },
        ]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('오래됨')).toBeInTheDocument();
        });
        expect(screen.getByText('5시간 전')).toHaveClass('text-yellow-500');
    });

    it('falls back from null sourceAnalyzedAt to analyzedAt', async () => {
        mockedApi.getAnalysis.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                analysisType: 'technical',
                result: JSON.stringify({ signal: 'bullish' }),
                createdAt: new Date().toISOString(),
                analyzedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
                sourceAnalyzedAt: null,
            },
        ]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('오래됨')).toBeInTheDocument();
        });
        expect(screen.getByText('5시간 전')).toHaveClass('text-yellow-500');
    });

    it('marks technical analysis stale at the 1Hour timeframe limit (2h), not the old 4h', async () => {
        mockTimeframe('1Hour');
        // 3h old: fresh under the old 4h rule, but stale under the 1Hour→2h execute gate
        mockedApi.getAnalysis.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                analysisType: 'technical',
                result: JSON.stringify({ signal: 'bullish' }),
                createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
            },
        ]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('오래됨')).toBeInTheDocument();
        });
    });

    it('applies the tighter 15Min limit (45m) to technical analysis', async () => {
        mockTimeframe('15Min');
        // 1h old: stale under 15Min→45m, even though fresh under 1Hour→2h
        mockedApi.getAnalysis.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                analysisType: 'technical',
                result: JSON.stringify({ signal: 'bullish' }),
                createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            },
        ]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('오래됨')).toBeInTheDocument();
        });
    });

    it('keeps the default 4h threshold for non-technical analysis', async () => {
        mockTimeframe('1Hour');
        // 3h old news: not gated by the technical timeframe limit, stays fresh under 4h
        mockedApi.getAnalysis.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                analysisType: 'news',
                result: JSON.stringify({ signal: 'neutral' }),
                createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
            },
        ]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });
        expect(screen.queryByText('오래됨')).not.toBeInTheDocument();
    });

    // --- Re-analysis trigger visibility ---

    it('hides re-analysis buttons for symbol groups', async () => {
        mockedApi.getAnalysis.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                analysisType: 'technical',
                result: JSON.stringify({ signal: 'bullish' }),
                createdAt: new Date().toISOString(),
            },
            {
                id: 2,
                symbol: 'TSLA',
                analysisType: 'news',
                result: JSON.stringify({ signal: 'neutral' }),
                createdAt: new Date().toISOString(),
            },
        ]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        expect(screen.queryByLabelText('AAPL 재분석')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('TSLA 재분석')).not.toBeInTheDocument();
    });

    it('does not call triggerAnalysis from the analysis page', async () => {
        mockedApi.getAnalysis.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                analysisType: 'technical',
                result: JSON.stringify({ signal: 'bullish' }),
                createdAt: new Date().toISOString(),
            },
        ]);
        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        expect(mockedApi.triggerAnalysis).not.toHaveBeenCalled();
    });

    // --- Signal extraction tests ---

    it('extracts trend field from result', async () => {
        mockedApi.getAnalysis.mockResolvedValue([
            {
                id: 1,
                symbol: 'MSFT',
                analysisType: 'technical',
                result: JSON.stringify({ trend: 'bearish' }),
                createdAt: new Date().toISOString(),
            },
        ]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('약세')).toBeInTheDocument();
        });
    });

    it('extracts overallSentiment field from result', async () => {
        mockedApi.getAnalysis.mockResolvedValue([
            {
                id: 1,
                symbol: 'MSFT',
                analysisType: 'news',
                result: JSON.stringify({ overallSentiment: 'bullish' }),
                createdAt: new Date().toISOString(),
            },
        ]);

        renderWithQuery(<AnalysisPage />);

        await waitFor(() => {
            expect(screen.getByText('강세')).toBeInTheDocument();
        });
    });
});
