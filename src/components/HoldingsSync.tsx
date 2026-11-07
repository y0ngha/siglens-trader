import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type HoldingsSyncItem, type HoldingsSyncPreview } from '@/lib/api';

/**
 * Toss 보유 → DB 포지션 동기화 카드 (설정 페이지).
 *
 * 비교는 버튼을 눌렀을 때만 한다 — 매번 브로커 API를 부르므로 자동 조회하지 않는다.
 * 적용은 서버가 브로커를 다시 읽어 미리보기 해시와 같을 때만 반영한다.
 */

const ACTION_LABEL: Record<HoldingsSyncItem['action'], string> = {
    update: '수정',
    close: '닫기',
    open: '열기',
};

function fmtPrice(n: number): string {
    return `$${n.toFixed(2)}`;
}

function describe(it: HoldingsSyncItem): { db: string; broker: string } {
    if (it.action === 'open') {
        return { db: '없음', broker: `${it.broker.quantity}주 @ ${fmtPrice(it.broker.avgPrice)}` };
    }
    const db = `${it.db.quantity}주 @ ${fmtPrice(it.db.avgPrice)}`;
    if (it.action === 'close') return { db, broker: `${it.brokerQuantity}주` };
    return { db, broker: `${it.broker.quantity}주 @ ${fmtPrice(it.broker.avgPrice)}` };
}

function errorText(err: unknown): string {
    return err instanceof ApiError ? err.displayMessage : String(err);
}

export function HoldingsSync() {
    const queryClient = useQueryClient();
    const [preview, setPreview] = useState<HoldingsSyncPreview | null>(null);
    const [result, setResult] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const previewMutation = useMutation({
        mutationFn: () => api.previewHoldingsSync(),
        onMutate: () => {
            setError(null);
            setResult(null);
        },
        onSuccess: (data) => setPreview(data),
        onError: (err) => {
            setPreview(null);
            setError(errorText(err));
        },
    });

    const applyMutation = useMutation({
        mutationFn: (hash: string) => api.applyHoldingsSync(hash),
        onMutate: () => setError(null),
        onSuccess: (data) => {
            setPreview(null);
            setResult(`${data.applied}건 동기화했습니다.`);
            void queryClient.invalidateQueries({ queryKey: ['positions'] });
            void queryClient.invalidateQueries({ queryKey: ['status'] });
        },
        onError: (err) => {
            setError(errorText(err));
            // 409(미리보기 이후 변경)면 새 목록을 보여 준다.
            setPreview(null);
        },
    });

    const busy = previewMutation.isPending || applyMutation.isPending;
    const items = preview?.items ?? [];
    const canApply =
        preview != null && preview.blockedBy == null && items.length > 0 && !!preview.hash;

    return (
        <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
            <h2 className="text-sm font-semibold">Toss 보유 동기화</h2>
            <p className="mt-1 text-[10px] text-neutral-600">
                봇이 다루는 종목의 DB 포지션(수량·평단)을 Toss 실제 보유에 맞춥니다. 거래 내역과
                손익에는 기록하지 않습니다.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => previewMutation.mutate()}
                    className="min-h-[44px] rounded border border-[#262626] px-3 py-1 text-xs text-neutral-300 hover:bg-[#1f1f1f] disabled:opacity-50"
                >
                    {previewMutation.isPending ? '비교 중…' : 'Toss와 비교'}
                </button>
                {canApply && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => applyMutation.mutate(preview.hash!)}
                        className="min-h-[44px] rounded border border-yellow-500/30 bg-yellow-500/10 px-3 py-1 text-xs text-yellow-400 disabled:opacity-50"
                    >
                        {applyMutation.isPending ? '적용 중…' : `전체 적용 (${items.length}건)`}
                    </button>
                )}
            </div>

            {error && (
                <p role="alert" className="mt-3 text-xs text-red-400">
                    {error}
                </p>
            )}
            {result && (
                <p role="status" className="mt-3 text-xs text-green-400">
                    {result}
                </p>
            )}

            {preview?.blockedBy === 'dry_run' && (
                <p className="mt-3 text-xs text-neutral-500">
                    dry_run 모드에서는 포지션이 시뮬레이션이라 동기화하지 않습니다.
                </p>
            )}
            {preview?.blockedBy === 'orders_in_flight' && (
                <p className="mt-3 text-xs text-yellow-500">
                    처리 중이거나 확인이 필요한 주문이 있어 적용할 수 없습니다 (
                    {preview.blockingSymbols.join(', ')}).
                </p>
            )}
            {preview && preview.blockedBy !== 'dry_run' && items.length === 0 && (
                <p className="mt-3 text-xs text-green-400">DB와 Toss 보유가 일치합니다.</p>
            )}

            {items.length > 0 && (
                <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-left text-xs">
                        <thead className="text-neutral-500">
                            <tr>
                                <th className="py-1 pr-3 font-medium">종목</th>
                                <th className="py-1 pr-3 font-medium">DB</th>
                                <th className="py-1 pr-3 font-medium">Toss</th>
                                <th className="py-1 font-medium">처리</th>
                            </tr>
                        </thead>
                        <tbody>
                            {items.map((it) => {
                                const d = describe(it);
                                return (
                                    <tr
                                        key={`${it.action}-${it.symbol}`}
                                        className="border-t border-[#262626]"
                                    >
                                        <td className="py-1 pr-3 font-mono">{it.symbol}</td>
                                        <td className="py-1 pr-3 text-neutral-400">{d.db}</td>
                                        <td className="py-1 pr-3 text-neutral-300">{d.broker}</td>
                                        <td className="py-1">{ACTION_LABEL[it.action]}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
