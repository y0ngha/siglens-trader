import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { HoldingsSync } from '../HoldingsSync';
import { api, ApiError, type HoldingsSyncPreview } from '@/lib/api';

vi.mock('@/lib/api', async (orig) => {
    const real = await orig<typeof import('@/lib/api')>();
    return {
        ...real,
        api: { previewHoldingsSync: vi.fn(), applyHoldingsSync: vi.fn() },
    };
});
const mockedApi = vi.mocked(api);

function renderIt() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <HoldingsSync />
        </QueryClientProvider>,
    );
}

const preview: HoldingsSyncPreview = {
    mode: 'auto',
    blockedBy: null,
    blockingSymbols: [],
    hash: 'h1',
    items: [
        {
            action: 'update',
            symbol: 'AAPL',
            positionId: 1,
            db: { quantity: 5, avgPrice: 189.5 },
            broker: { quantity: 6, avgPrice: 188.1 },
            brokerQuantity: 6,
            quantityMismatch: true,
        },
        {
            action: 'close',
            symbol: 'NVDA',
            positionId: 2,
            db: { quantity: 3, avgPrice: 875.2 },
            brokerQuantity: 0,
        },
        { action: 'open', symbol: 'AMD', broker: { quantity: 4, avgPrice: 150 } },
    ],
};

describe('HoldingsSync', () => {
    beforeEach(() => vi.clearAllMocks());

    it('does not call the broker until asked', () => {
        renderIt();
        expect(mockedApi.previewHoldingsSync).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: /전체 적용/ })).toBeNull();
    });

    it('shows the diff and applies it with the preview hash', async () => {
        mockedApi.previewHoldingsSync.mockResolvedValue(preview);
        mockedApi.applyHoldingsSync.mockResolvedValue({ applied: 3, items: [] });
        renderIt();
        await userEvent.click(screen.getByRole('button', { name: 'Toss와 비교' }));
        expect(await screen.findByText('AAPL')).toBeInTheDocument();
        expect(screen.getByText('5주 @ $189.50')).toBeInTheDocument();
        expect(screen.getByText('6주 @ $188.10')).toBeInTheDocument();
        expect(screen.getByText('0주')).toBeInTheDocument();
        expect(screen.getByText('없음')).toBeInTheDocument();
        expect(screen.getByText('수정')).toBeInTheDocument();
        expect(screen.getByText('닫기')).toBeInTheDocument();
        expect(screen.getByText('열기')).toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: '전체 적용 (3건)' }));
        await waitFor(() => expect(mockedApi.applyHoldingsSync).toHaveBeenCalledWith('h1'));
        expect(await screen.findByRole('status')).toHaveTextContent('3건 동기화했습니다.');
        expect(screen.queryByText('AAPL')).toBeNull();
    });

    it('says when everything matches', async () => {
        mockedApi.previewHoldingsSync.mockResolvedValue({ ...preview, items: [], hash: 'e' });
        renderIt();
        await userEvent.click(screen.getByRole('button', { name: 'Toss와 비교' }));
        expect(await screen.findByText('DB와 Toss 보유가 일치합니다.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /전체 적용/ })).toBeNull();
    });

    it('explains dry_run', async () => {
        mockedApi.previewHoldingsSync.mockResolvedValue({
            ...preview,
            mode: 'dry_run',
            blockedBy: 'dry_run',
            items: [],
            hash: null,
        });
        renderIt();
        await userEvent.click(screen.getByRole('button', { name: 'Toss와 비교' }));
        expect(await screen.findByText(/dry_run 모드/)).toBeInTheDocument();
        expect(screen.queryByText('DB와 Toss 보유가 일치합니다.')).toBeNull();
    });

    it('shows the diff but blocks applying while orders are in flight', async () => {
        mockedApi.previewHoldingsSync.mockResolvedValue({
            ...preview,
            blockedBy: 'orders_in_flight',
            blockingSymbols: ['NVDA'],
        });
        renderIt();
        await userEvent.click(screen.getByRole('button', { name: 'Toss와 비교' }));
        expect(await screen.findByText(/적용할 수 없습니다 \(\s*NVDA\)/)).toBeInTheDocument();
        expect(screen.getByText('AAPL')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /전체 적용/ })).toBeNull();
    });

    it('shows the server error on preview failure', async () => {
        mockedApi.previewHoldingsSync.mockRejectedValue(
            new ApiError(502, JSON.stringify({ error: 'Toss 보유 조회 실패: x' })),
        );
        renderIt();
        await userEvent.click(screen.getByRole('button', { name: 'Toss와 비교' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Toss 보유 조회 실패: x');
    });

    it('shows a conflict on apply and drops the stale preview', async () => {
        mockedApi.previewHoldingsSync.mockResolvedValue(preview);
        mockedApi.applyHoldingsSync.mockRejectedValue(new Error('changed'));
        renderIt();
        await userEvent.click(screen.getByRole('button', { name: 'Toss와 비교' }));
        await userEvent.click(await screen.findByRole('button', { name: '전체 적용 (3건)' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('changed');
        expect(screen.queryByText('AAPL')).toBeNull();
    });
});
