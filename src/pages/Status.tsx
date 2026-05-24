import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card } from '@/components/Card';
import { ErrorMessage } from '@/components/ErrorMessage';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';

function modeLabel(mode: string): string {
    switch (mode) {
        case 'paper':
            return '모의투자';
        case 'semi-auto':
            return '반자동';
        case 'auto':
            return '자동';
        default:
            return mode;
    }
}

export function StatusPage() {
    const { data, isLoading, error } = useQuery({
        queryKey: ['status'],
        queryFn: ({ signal }) => api.getStatus(signal),
    });

    if (isLoading) return <LoadingSkeleton />;
    if (error) return <ErrorMessage error={error as Error} />;
    if (!data) return null;

    return (
        <div className="space-y-4">
            <h1 className="text-lg font-semibold">시스템 상태</h1>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Card
                    label="상태"
                    value={data.running ? '실행 중' : '정지'}
                    indicator={data.running ? 'green' : 'red'}
                />
                <Card label="모드" value={modeLabel(data.tradingMode)} />
                <Card label="활성 포지션" value={String(data.activePositions)} />
                <Card label="오늘 거래" value={String(data.todayTrades)} />
            </div>
        </div>
    );
}
