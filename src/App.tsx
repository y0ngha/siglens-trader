import { BrowserRouter, Routes, Route, NavLink } from 'react-router';
import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

const StatusPage = lazy(() => import('./pages/Status').then((m) => ({ default: m.StatusPage })));
const PositionsPage = lazy(() =>
    import('./pages/Positions').then((m) => ({ default: m.PositionsPage })),
);
const TradesPage = lazy(() => import('./pages/Trades').then((m) => ({ default: m.TradesPage })));
const AnalysisPage = lazy(() =>
    import('./pages/Analysis').then((m) => ({ default: m.AnalysisPage })),
);
const PendingPage = lazy(() => import('./pages/Pending').then((m) => ({ default: m.PendingPage })));
const SettingsPage = lazy(() =>
    import('./pages/Settings').then((m) => ({ default: m.SettingsPage })),
);

interface NavItem {
    to: string;
    label: string;
    badge?: number;
}

export function App() {
    const { data: pendingOrders } = useQuery({
        queryKey: ['pending'],
        queryFn: ({ signal }) => api.getPending(signal),
    });
    const pendingCount = pendingOrders?.length ?? 0;

    const navItems: NavItem[] = [
        { to: '/', label: '상태' },
        { to: '/positions', label: '포지션' },
        { to: '/trades', label: '거래' },
        { to: '/analysis', label: '분석' },
        { to: '/pending', label: '승인', badge: pendingCount },
        { to: '/settings', label: '설정' },
    ];

    return (
        <BrowserRouter>
            <div className="flex min-h-dvh flex-col bg-[#0a0a0a] text-[#fafafa]">
                <nav
                    className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-[#262626] bg-[#0a0a0a]/80 px-3 py-2 backdrop-blur-sm sm:gap-3 sm:px-4 sm:py-3"
                    aria-label="Main navigation"
                >
                    {navItems.map((item) => (
                        <NavLink
                            key={item.to}
                            to={item.to}
                            end={item.to === '/'}
                            className={({ isActive }) =>
                                `flex items-center rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors ${isActive ? 'bg-[#262626] text-white' : 'text-neutral-400 hover:text-neutral-200'}`
                            }
                        >
                            {item.label}
                            {item.badge != null && item.badge > 0 && (
                                <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                                    {item.badge}
                                </span>
                            )}
                        </NavLink>
                    ))}
                </nav>
                <main className="flex-1 p-3 sm:p-4">
                    <Suspense fallback={<LoadingSpinner />}>
                        <Routes>
                            <Route path="/" element={<StatusPage />} />
                            <Route path="/positions" element={<PositionsPage />} />
                            <Route path="/trades" element={<TradesPage />} />
                            <Route path="/analysis" element={<AnalysisPage />} />
                            <Route path="/pending" element={<PendingPage />} />
                            <Route path="/settings" element={<SettingsPage />} />
                        </Routes>
                    </Suspense>
                </main>
            </div>
        </BrowserRouter>
    );
}

function LoadingSpinner() {
    return (
        <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-300" />
        </div>
    );
}
