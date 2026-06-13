/**
 * Mobile nav tests (4 primary tabs + 더보기 overflow sheet).
 * Tests the REAL MobileNav component from src/components/MobileNav.tsx.
 * MobileNav receives navItems as props — no API dependency.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect } from 'vitest';
import { MobileNav } from '@/components/MobileNav';
import type { NavItem } from '@/components/MobileNav';

const TEST_NAV_ITEMS: NavItem[] = [
    { to: '/', label: '상태', icon: '●', primary: true },
    { to: '/positions', label: '포지션', icon: '◆', primary: true },
    { to: '/trades', label: '거래', icon: '↕', primary: true },
    { to: '/analysis', label: '분석', icon: '◎', primary: false },
    { to: '/audit', label: '감사', icon: '▦', primary: false },
    { to: '/pending', label: '승인', icon: '✓', badge: 0, primary: true },
    { to: '/settings', label: '설정', icon: '⚙', primary: false },
];

function renderMobileNav(initialRoute = '/') {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });

    return render(
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[initialRoute]}>
                <MobileNav navItems={TEST_NAV_ITEMS} />
            </MemoryRouter>
        </QueryClientProvider>,
    );
}

describe('MobileNav — primary tabs', () => {
    it('renders exactly 4 primary tab links', () => {
        renderMobileNav();
        const nav = screen.getByTestId('mobile-nav');
        const links = within(nav).getAllByRole('link');
        expect(links).toHaveLength(4);
    });

    it('renders 상태, 포지션, 거래, 승인 as primary tabs', () => {
        renderMobileNav();
        const nav = screen.getByTestId('mobile-nav');
        expect(within(nav).getByText('상태')).toBeInTheDocument();
        expect(within(nav).getByText('포지션')).toBeInTheDocument();
        expect(within(nav).getByText('거래')).toBeInTheDocument();
        expect(within(nav).getByText('승인')).toBeInTheDocument();
    });

    it('does NOT render 분석, 감사, 설정 directly in the primary bar', () => {
        renderMobileNav();
        const nav = screen.getByTestId('mobile-nav');
        expect(within(nav).queryByText('분석')).not.toBeInTheDocument();
        expect(within(nav).queryByText('감사')).not.toBeInTheDocument();
        expect(within(nav).queryByText('설정')).not.toBeInTheDocument();
    });

    it('renders a 더보기 button in the nav bar', () => {
        renderMobileNav();
        const nav = screen.getByTestId('mobile-nav');
        expect(within(nav).getByText('더보기')).toBeInTheDocument();
    });

    it('더보기 button has aria-expanded=false initially', () => {
        renderMobileNav();
        const btn = screen.getByTestId('more-button');
        expect(btn).toHaveAttribute('aria-expanded', 'false');
    });
});

describe('MobileNav — overflow sheet', () => {
    it('overflow sheet is NOT in the DOM before sheet opens', () => {
        renderMobileNav();
        expect(screen.queryByTestId('overflow-sheet')).not.toBeInTheDocument();
    });

    it('clicking 더보기 mounts and opens the sheet', async () => {
        const user = userEvent.setup();
        renderMobileNav();

        const btn = screen.getByTestId('more-button');
        await user.click(btn);

        expect(screen.getByTestId('overflow-sheet')).toBeInTheDocument();
        expect(btn).toHaveAttribute('aria-expanded', 'true');
    });

    it('sheet shows 분석, 감사, 설정 when open', async () => {
        const user = userEvent.setup();
        renderMobileNav();

        await user.click(screen.getByTestId('more-button'));

        const sheet = screen.getByTestId('overflow-sheet');
        expect(within(sheet).getByText('분석')).toBeInTheDocument();
        expect(within(sheet).getByText('감사')).toBeInTheDocument();
        expect(within(sheet).getByText('설정')).toBeInTheDocument();
    });

    it('clicking backdrop closes the sheet and removes it from DOM', async () => {
        const user = userEvent.setup();
        renderMobileNav();

        await user.click(screen.getByTestId('more-button'));
        expect(screen.getByTestId('overflow-sheet')).toBeInTheDocument();

        // The backdrop is the sibling div with aria-hidden
        const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
        await user.click(backdrop);

        expect(screen.queryByTestId('overflow-sheet')).not.toBeInTheDocument();
    });

    it('pressing Escape closes the sheet and removes it from DOM', async () => {
        const user = userEvent.setup();
        renderMobileNav();

        await user.click(screen.getByTestId('more-button'));
        expect(screen.getByTestId('overflow-sheet')).toBeInTheDocument();

        await user.keyboard('{Escape}');
        expect(screen.queryByTestId('overflow-sheet')).not.toBeInTheDocument();
    });

    it('clicking an overflow item closes the sheet and removes it from DOM', async () => {
        const user = userEvent.setup();
        renderMobileNav();

        await user.click(screen.getByTestId('more-button'));

        const analysisLink = screen.getByTestId('overflow-link-분석');
        await user.click(analysisLink);

        expect(screen.queryByTestId('overflow-sheet')).not.toBeInTheDocument();
    });
});

describe('MobileNav — 더보기 active state on overflow route', () => {
    it('더보기 button shows overflow-active=true when on /analysis', () => {
        renderMobileNav('/analysis');
        const btn = screen.getByTestId('more-button');
        expect(btn).toHaveAttribute('data-overflow-active', 'true');
    });

    it('더보기 button shows overflow-active=true when on /audit', () => {
        renderMobileNav('/audit');
        expect(screen.getByTestId('more-button')).toHaveAttribute('data-overflow-active', 'true');
    });

    it('더보기 button shows overflow-active=true when on /settings', () => {
        renderMobileNav('/settings');
        expect(screen.getByTestId('more-button')).toHaveAttribute('data-overflow-active', 'true');
    });

    it('더보기 button shows overflow-active=false when on primary route /', () => {
        renderMobileNav('/');
        expect(screen.getByTestId('more-button')).toHaveAttribute('data-overflow-active', 'false');
    });

    it('더보기 button shows overflow-active=false when on primary route /trades', () => {
        renderMobileNav('/trades');
        expect(screen.getByTestId('more-button')).toHaveAttribute('data-overflow-active', 'false');
    });
});

describe('MobileNav — 승인 badge', () => {
    it('renders badge on 승인 when count > 0', () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const itemsWithBadge = TEST_NAV_ITEMS.map((item) =>
            item.to === '/pending' ? { ...item, badge: 3 } : item,
        );

        render(
            <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={['/']}>
                    <MobileNav navItems={itemsWithBadge} />
                </MemoryRouter>
            </QueryClientProvider>,
        );

        expect(screen.getByTestId('badge')).toBeInTheDocument();
        expect(screen.getByTestId('badge')).toHaveTextContent('3');
    });

    it('does not render badge when count is 0', () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        render(
            <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={['/']}>
                    <MobileNav navItems={TEST_NAV_ITEMS} />
                </MemoryRouter>
            </QueryClientProvider>,
        );

        expect(screen.queryByTestId('badge')).not.toBeInTheDocument();
    });
});
