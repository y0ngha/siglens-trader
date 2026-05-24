import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TickerSearch } from '../TickerSearch';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
    api: {
        searchTickers: vi.fn(),
    },
}));

const mockedApi = vi.mocked(api);

function renderWithQuery(component: React.ReactElement) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(<QueryClientProvider client={queryClient}>{component}</QueryClientProvider>);
}

const mockResults = [
    { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ' },
    { symbol: 'AMZN', name: 'Amazon.com Inc.', exchange: 'NASDAQ' },
];

describe('TickerSearch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders search input with correct aria attributes', () => {
        const onSelect = vi.fn();
        renderWithQuery(<TickerSearch onSelect={onSelect} />);

        const input = screen.getByRole('combobox');
        expect(input).toBeInTheDocument();
        expect(input).toHaveAttribute('aria-label', '종목 검색');
        expect(input).toHaveAttribute('aria-autocomplete', 'list');
        expect(input).toHaveAttribute('aria-expanded', 'false');
    });

    it('shows dropdown when typing and results are available', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        mockedApi.searchTickers.mockResolvedValue(mockResults);

        renderWithQuery(<TickerSearch onSelect={onSelect} />);

        const input = screen.getByRole('combobox');
        await user.type(input, 'AA');

        await waitFor(() => {
            expect(screen.getByRole('listbox')).toBeInTheDocument();
        });

        expect(screen.getByText('AAPL')).toBeInTheDocument();
        expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
        expect(screen.getByText('AMZN')).toBeInTheDocument();
        expect(screen.getByText('Amazon.com Inc.')).toBeInTheDocument();
    });

    it('calls onSelect when an item is clicked', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        mockedApi.searchTickers.mockResolvedValue(mockResults);

        renderWithQuery(<TickerSearch onSelect={onSelect} />);

        const input = screen.getByRole('combobox');
        await user.type(input, 'AA');

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        const aaplButton = screen.getByText('AAPL').closest('button')!;
        await user.click(aaplButton);

        expect(onSelect).toHaveBeenCalledWith({
            symbol: 'AAPL',
            name: 'Apple Inc.',
            exchange: 'NASDAQ',
        });
    });

    it('clears input and closes dropdown after selection', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        mockedApi.searchTickers.mockResolvedValue(mockResults);

        renderWithQuery(<TickerSearch onSelect={onSelect} />);

        const input = screen.getByRole('combobox');
        await user.type(input, 'AA');

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        const aaplButton = screen.getByText('AAPL').closest('button')!;
        await user.click(aaplButton);

        expect(input).toHaveValue('');
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('hides dropdown on click outside', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        mockedApi.searchTickers.mockResolvedValue(mockResults);

        renderWithQuery(
            <div>
                <TickerSearch onSelect={onSelect} />
                <button type="button">외부 버튼</button>
            </div>,
        );

        const input = screen.getByRole('combobox');
        await user.type(input, 'AA');

        await waitFor(() => {
            expect(screen.getByRole('listbox')).toBeInTheDocument();
        });

        fireEvent.mouseDown(screen.getByText('외부 버튼'));

        expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('shows empty state when no results found', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        mockedApi.searchTickers.mockResolvedValue([]);

        renderWithQuery(<TickerSearch onSelect={onSelect} />);

        const input = screen.getByRole('combobox');
        await user.type(input, 'XYZ');

        await waitFor(() => {
            expect(screen.getByText('검색 결과 없음')).toBeInTheDocument();
        });
    });

    it('sets aria-expanded to true when dropdown is visible', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        mockedApi.searchTickers.mockResolvedValue(mockResults);

        renderWithQuery(<TickerSearch onSelect={onSelect} />);

        const input = screen.getByRole('combobox');
        await user.type(input, 'AA');

        await waitFor(() => {
            expect(input).toHaveAttribute('aria-expanded', 'true');
        });
    });

    it('uses custom placeholder when provided', () => {
        const onSelect = vi.fn();
        renderWithQuery(<TickerSearch onSelect={onSelect} placeholder="검색..." />);

        expect(screen.getByPlaceholderText('검색...')).toBeInTheDocument();
    });
});
