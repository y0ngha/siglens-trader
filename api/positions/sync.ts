import crypto from 'node:crypto';
import { isAuthenticated } from '../_lib/auth.js';
import { getDb } from '../_lib/db.js';
import {
    finishCronRun,
    getBotManagedSymbols,
    getConfigValue,
    getNeedsReviewSymbols,
    getOpenPositions,
    getPendingSubmittedOrders,
    startCronRun,
} from '../../lib/db/queries.js';
import type { Db } from '../../lib/db/index.js';
import {
    actionableItems,
    applyHoldingsSync,
    diffHoldings,
    hashSyncItems,
    HoldingsSyncConflictError,
    type HoldingsSyncItem,
} from '../../lib/db/holdings-sync.js';
import { getHoldings } from '../../lib/trading/account.js';
import { acquireLockDetailed, releaseLock } from '../../lib/lock.js';

/**
 * Toss 보유 → DB 포지션 동기화 (docs/specs/2026-11-06-holdings-sync-design.md).
 *
 * - `GET`  미리보기: 차이 목록 + 해시 + 적용을 막는 사유.
 * - `POST { hash }` 적용: 브로커를 **다시** 읽어 diff를 재계산하고, 해시가 미리보기와 다르면 409.
 *
 * trades에는 쓰지 않는다 — 장부 교정은 체결이 아니다. 감사는 `cron_runs`(`holdings_sync`).
 */

const EXECUTE_LOCK_KEY = 'cron:execute:lock';
const RECONCILE_LOCK_KEY = 'cron:reconcile:lock';
const LOCK_TTL_SEC = 120;
/** 이보다 오래된 `needs_review`는 사람이 이미 봤다고 본다. */
const NEEDS_REVIEW_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type SyncBlockReason = 'dry_run' | 'orders_in_flight';

interface SyncState {
    mode: string;
    blockedBy: SyncBlockReason | null;
    /** 적용을 막는 주문의 심볼(in-flight + needs_review). */
    blockingSymbols: string[];
}

async function readState(db: Db): Promise<SyncState> {
    const mode = (await getConfigValue<string>(db, 'trading_mode')) ?? 'dry_run';
    if (mode === 'dry_run') return { mode, blockedBy: 'dry_run', blockingSymbols: [] };
    const [inflight, needsReview] = await Promise.all([
        getPendingSubmittedOrders(db),
        getNeedsReviewSymbols(db, new Date(Date.now() - NEEDS_REVIEW_LOOKBACK_MS)),
    ]);
    const blockingSymbols = [...new Set([...inflight.map((o) => o.symbol), ...needsReview])].sort();
    return {
        mode,
        blockedBy: blockingSymbols.length > 0 ? 'orders_in_flight' : null,
        blockingSymbols,
    };
}

async function computeItems(db: Db): Promise<HoldingsSyncItem[]> {
    const [holdings, openPositions, managedSymbols] = await Promise.all([
        getHoldings(),
        getOpenPositions(db),
        getBotManagedSymbols(db),
    ]);
    return actionableItems(diffHoldings(openPositions, holdings, managedSymbols));
}

function blockedResponse(state: SyncState): Response {
    const error =
        state.blockedBy === 'dry_run'
            ? 'dry_run 모드에서는 포지션이 시뮬레이션이라 동기화할 수 없습니다.'
            : `처리 중이거나 확인이 필요한 주문이 있습니다 (${state.blockingSymbols.join(', ')}). 정리된 뒤 다시 시도하세요.`;
    return Response.json({ error, blockedBy: state.blockedBy }, { status: 409 });
}

async function preview(db: Db): Promise<Response> {
    const state = await readState(db);
    if (state.blockedBy === 'dry_run') {
        return Response.json({ ...state, items: [], hash: null });
    }
    let items: HoldingsSyncItem[];
    try {
        items = await computeItems(db);
    } catch (err) {
        return brokerError(err);
    }
    return Response.json({ ...state, items, hash: hashSyncItems(items) });
}

function brokerError(err: unknown): Response {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[positions/sync] broker holdings unavailable', { error: message });
    return Response.json({ error: `Toss 보유 조회 실패: ${message}` }, { status: 502 });
}

async function apply(db: Db, req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const expectedHash = typeof body.hash === 'string' ? body.hash : null;
    if (!expectedHash) return Response.json({ error: 'hash가 필요합니다' }, { status: 400 });

    // 크론이 장부를 바꾸는 도중에 끼어들지 않는다. 둘 다 못 잡으면 하나라도 풀고 거부.
    const execLock = await acquireLockDetailed(EXECUTE_LOCK_KEY, LOCK_TTL_SEC);
    if (!execLock.token) {
        return Response.json(
            { error: '매매 실행 크론이 돌고 있습니다. 잠시 뒤 다시 시도하세요.' },
            { status: 409 },
        );
    }
    const recLock = await acquireLockDetailed(RECONCILE_LOCK_KEY, LOCK_TTL_SEC);
    if (!recLock.token) {
        await releaseLock(EXECUTE_LOCK_KEY, execLock.token).catch(() => {});
        return Response.json(
            { error: '정합성 크론이 돌고 있습니다. 잠시 뒤 다시 시도하세요.' },
            { status: 409 },
        );
    }

    try {
        // 락을 잡은 뒤에 상태를 본다 — 그 전에 본 "주문 없음"은 크론이 끼어들 틈이 있다.
        const state = await readState(db);
        if (state.blockedBy) return blockedResponse(state);

        let items: HoldingsSyncItem[];
        try {
            items = await computeItems(db);
        } catch (err) {
            return brokerError(err);
        }
        const hash = hashSyncItems(items);
        if (hash !== expectedHash) {
            return Response.json(
                { error: '미리보기 이후 보유가 바뀌었습니다. 다시 비교하세요.', items, hash },
                { status: 409 },
            );
        }
        if (items.length === 0) return Response.json({ applied: 0, items });

        const runId = `holdings_sync-${crypto.randomUUID()}`;
        const startedAt = new Date();
        await startCronRun(db, { runId, cronType: 'holdings_sync', startedAt });
        try {
            const { applied } = await applyHoldingsSync(db, items);
            await finishCronRun(db, runId, {
                status: 'completed',
                outcome: 'completed',
                summary: { mode: state.mode, applied, items },
                durationMs: Date.now() - startedAt.getTime(),
                finishedAt: new Date(),
            });
            return Response.json({ applied, items });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await finishCronRun(db, runId, {
                status: 'error',
                error: message,
                summary: { mode: state.mode, applied: 0, items },
                durationMs: Date.now() - startedAt.getTime(),
                finishedAt: new Date(),
            }).catch((e) => console.error('[positions/sync] audit finish failed', e));
            if (err instanceof HoldingsSyncConflictError) {
                return Response.json({ error: message }, { status: 409 });
            }
            throw err;
        }
    } finally {
        await releaseLock(RECONCILE_LOCK_KEY, recLock.token).catch(() => {});
        await releaseLock(EXECUTE_LOCK_KEY, execLock.token).catch(() => {});
    }
}

async function handler(req: Request): Promise<Response> {
    if (!(await isAuthenticated(req))) return new Response('Forbidden', { status: 403 });
    const db = getDb();
    if (req.method === 'GET') return preview(db);
    if (req.method === 'POST') return apply(db, req);
    return new Response(null, { status: 405 });
}

export const GET = handler;
export const POST = handler;
