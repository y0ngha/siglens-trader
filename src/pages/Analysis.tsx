import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { ErrorMessage } from '@/components/ErrorMessage';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';

interface AnalysisEntry {
    id: number;
    symbol: string;
    analysisType: string;
    result: unknown;
    createdAt: string;
    analyzedAt?: string | null;
    sourceAnalyzedAt?: string | null;
}

interface ConfigEntry {
    key: string;
    value: unknown;
}
interface ConfigData {
    config: ConfigEntry[];
}

// 서버의 analysis_timeframe 계약(15Min/30Min/1Hour, 기본 1Hour) 미러.
// src/는 lib/(서버 코드)를 import하지 않으므로 클라이언트용 최소 정의를 둔다.
const ANALYSIS_TIMEFRAMES = ['15Min', '30Min', '1Hour'] as const;
type AnalysisTimeframe = (typeof ANALYSIS_TIMEFRAMES)[number];
const DEFAULT_ANALYSIS_TIMEFRAME: AnalysisTimeframe = '1Hour';
function normalizeAnalysisTimeframe(value: unknown): AnalysisTimeframe {
    return ANALYSIS_TIMEFRAMES.includes(value as AnalysisTimeframe)
        ? (value as AnalysisTimeframe)
        : DEFAULT_ANALYSIS_TIMEFRAME;
}

// 기술적 분석은 execute 크론과 동일한 타임프레임별 신선도 한도를 사용한다
// (lib/analysis/timeframe.ts getTechnicalMaxAgeMs 미러). 그래야 화면의 "오래됨"
// 표시가 execute가 stale_analysis로 매매를 건너뛰는 기준과 어긋나지 않는다.
const TECHNICAL_MAX_AGE_MS: Record<AnalysisTimeframe, number> = {
    '15Min': 45 * 60_000,
    '30Min': 90 * 60_000,
    '1Hour': 2 * 60 * 60_000,
};
// 뉴스/옵션/펀더멘털은 execute에 하드 신선도 게이트가 없어 일반 기준(4시간)을 쓴다.
const DEFAULT_STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000;

function staleThresholdMs(type: string, timeframe: AnalysisTimeframe): number {
    return type === 'technical' ? TECHNICAL_MAX_AGE_MS[timeframe] : DEFAULT_STALE_THRESHOLD_MS;
}

function typeLabel(type: string): string {
    switch (type) {
        case 'technical':
            return '기술적';
        case 'news':
            return '뉴스';
        case 'options':
            return '옵션';
        case 'fundamental':
            return '펀더멘털';
        default:
            return type;
    }
}

function signalVariant(signal: string): 'green' | 'red' | 'neutral' {
    if (signal === 'bullish') return 'green';
    if (signal === 'bearish') return 'red';
    return 'neutral';
}

function signalLabel(signal: string): string {
    switch (signal) {
        case 'bullish':
            return '강세';
        case 'bearish':
            return '약세';
        case 'neutral':
            return '중립';
        default:
            return signal;
    }
}

function extractSignal(result: unknown): string {
    try {
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        if (!parsed || typeof parsed !== 'object') return 'neutral';
        const obj = parsed as Record<string, unknown>;
        const signal = obj.trend ?? obj.overallSentiment ?? obj.signal;
        return typeof signal === 'string' ? signal : 'neutral';
    } catch {
        return 'neutral';
    }
}

function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return '방금 전';
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간 전`;
    const days = Math.floor(hours / 24);
    return `${days}일 전`;
}

function getReferenceDate(entry: AnalysisEntry): string {
    return entry.sourceAnalyzedAt ?? entry.analyzedAt ?? entry.createdAt;
}

function isEntryStale(entry: AnalysisEntry, timeframe: AnalysisTimeframe): boolean {
    const age = Date.now() - new Date(getReferenceDate(entry)).getTime();
    return age > staleThresholdMs(entry.analysisType, timeframe);
}

function getLatestEntry(entries: AnalysisEntry[]): AnalysisEntry {
    return entries.reduce((latest, entry) =>
        new Date(getReferenceDate(entry)).getTime() > new Date(getReferenceDate(latest)).getTime()
            ? entry
            : latest,
    );
}

export function AnalysisPage() {
    const { data, isLoading, error } = useQuery({
        queryKey: ['analysis'],
        queryFn: ({ signal }) => api.getAnalysis(undefined, signal) as Promise<AnalysisEntry[]>,
    });
    const { data: configData } = useQuery({
        queryKey: ['config'],
        queryFn: ({ signal }) => api.getConfig(signal) as Promise<ConfigData>,
    });

    const analysisTimeframe = normalizeAnalysisTimeframe(
        configData?.config?.find((c) => c.key === 'analysis_timeframe')?.value,
    );

    if (isLoading) return <LoadingSkeleton />;
    if (error) return <ErrorMessage error={error as Error} />;
    if (!data || !Array.isArray(data) || data.length === 0)
        return <EmptyState message="분석 결과가 없습니다" />;

    const grouped = data.reduce<Record<string, AnalysisEntry[]>>((acc, entry) => {
        if (!acc[entry.symbol]) acc[entry.symbol] = [];
        acc[entry.symbol].push(entry);
        return acc;
    }, {});

    return (
        <div className="space-y-4">
            <h1 className="text-lg font-semibold">분석 결과</h1>
            <ul className="space-y-3">
                {Object.entries(grouped).map(([symbol, entries]) => {
                    const stale = isEntryStale(getLatestEntry(entries), analysisTimeframe);

                    return (
                        <li
                            key={symbol}
                            className={`rounded-lg border bg-[#141414] p-4 ${stale ? 'border-yellow-500/30' : 'border-[#262626]'}`}
                        >
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <h2 className="text-sm font-semibold">{symbol}</h2>
                                    {stale && (
                                        <span className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">
                                            오래됨
                                        </span>
                                    )}
                                </div>
                            </div>
                            <ul className="mt-2 space-y-1.5">
                                {entries.map((entry) => {
                                    const signal = extractSignal(entry.result);
                                    const referenceDate = getReferenceDate(entry);
                                    return (
                                        <li
                                            key={entry.id}
                                            className="flex items-center justify-between text-xs"
                                        >
                                            <div className="flex items-center gap-2">
                                                <span className="text-neutral-400">
                                                    {typeLabel(entry.analysisType)}
                                                </span>
                                                <Badge
                                                    label={signalLabel(signal)}
                                                    variant={signalVariant(signal)}
                                                />
                                            </div>
                                            <span
                                                className={`${isEntryStale(entry, analysisTimeframe) ? 'text-yellow-500' : 'text-neutral-500'}`}
                                            >
                                                {timeAgo(referenceDate)}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
