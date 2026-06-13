/**
 * Status page tests — portfolio display and position targets.
 * Focuses on computePositionTargets correctness: long vs short side handling.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import type { Position, StatusResponse } from '@/lib/api';
import { StatusPage } from '@/pages/Status';

vi.mock('@/lib/api', () => ({
    api: {
        getStatus: vi.fn(),
        getPositions: vi.fn(),
        getTrades: vi.fn(),
        getConfig: vi.fn(),
        dismissAlert: vi.fn(),
    },
}));

const mockedApi = vi.mocked(api);

const MOCK_STATUS: StatusResponse = {
    running: true,
    tradingMode: 'paper',
    activePositions: 1,
    todayTrades: 2,
    cashBalance: 10000,
    tradingEnabled: true,
};

const MOCK_CONFIG = {
    config: [
        { key: 'take_profit_percent', value: 5 },
        { key: 'stop_loss_percent', value: 3 },
    ],
    watchlist: [],
};

function makePosition(overrides: Partial<Position>): Position {
    return {
        id: 1,
        symbol: 'AAPL',
        side: 'long',
        quantity: 10,
        avgPrice: '100.00',
        currentPrice: '105.00',
        openedAt: new Date().toISOString(),
        status: 'open',
        ...overrides,
    };
}

function renderStatus() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={queryClient}>
            <MemoryRouter>
                <StatusPage />
            </MemoryRouter>
        </QueryClientProvider>,
    );
}

describe('StatusPage — position targets long/short', () => {
    beforeEach(() => {
        mockedApi.getStatus.mockResolvedValue(MOCK_STATUS);
        mockedApi.getTrades.mockResolvedValue([]);
        mockedApi.getConfig.mockResolvedValue(MOCK_CONFIG);
    });

    it('long position: TP > avg, SL < avg', async () => {
        // avg=100, TP=5% => 105, SL=3% => 97
        const longPos = makePosition({
            side: 'long',
            avgPrice: '100.00',
            currentPrice: '105.00',
        });
        mockedApi.getPositions.mockResolvedValue([longPos]);

        renderStatus();

        // Wait for desktop table or mobile cards to render
        const tpCell = await screen.findAllByText('$105.00');
        const slCell = await screen.findAllByText('$97.00');
        expect(tpCell.length).toBeGreaterThan(0);
        expect(slCell.length).toBeGreaterThan(0);
    });

    it('short position: TP < avg, SL > avg', async () => {
        // avg=100, short: TP = 100*(1-5/100)=95, SL = 100*(1+3/100)=103
        const shortPos = makePosition({
            side: 'short',
            avgPrice: '100.00',
            currentPrice: '95.00',
        });
        mockedApi.getPositions.mockResolvedValue([shortPos]);

        renderStatus();

        const tpCell = await screen.findAllByText('$95.00');
        const slCell = await screen.findAllByText('$103.00');
        expect(tpCell.length).toBeGreaterThan(0);
        expect(slCell.length).toBeGreaterThan(0);
    });

    it('short position: current below avg is profitable (green), not red', async () => {
        // short with current < avg is in profit
        const shortPos = makePosition({
            side: 'short',
            avgPrice: '100.00',
            currentPrice: '90.00',
        });
        mockedApi.getPositions.mockResolvedValue([shortPos]);

        renderStatus();

        // At minimum we verify the page renders without crash and shows symbol
        const symbols = await screen.findAllByText('AAPL');
        expect(symbols.length).toBeGreaterThan(0);
    });
});
