# server/ — Hono app + in-process cron

`index.ts` boots the HTTP server and `startCron()`; `app.ts` mounts every `api/` handler on a Hono
route and registers the node-cron tasks in `CRON_JOBS`. Handler logic lives in `api/` — this
directory only decides **when** and **where** it runs.

Graceful shutdown stops the cron tasks, **waits up to 20s for in-flight ticks** (`drainCron`),
drains HTTP, and hard-exits after 25s. `task.stop()` only blocks the *next* tick — without the
drain, a deploy landing between `issueOrder` and its booking transaction leaves the broker filled
and the DB holding a bare `submitted` row (30 minutes to reconcile, then manual). It still does
**not** release Redis locks: a run killed past the drain window leaves its lock held until the TTL
(30 min for the analysis and execute crons), so a deploy during the session can cost that much
cron downtime.

`startCron` **throws** in production when `CRON_SECRET` is unset. Returning an empty task list
there is a full stop of trading, reconciliation and analysis behind a health check that still
answers 200 — the deploy would be recorded as a success and cron-health cannot report it, because
cron-health runs inside the digest cron that is also not running.

## Cron Schedule

**Cron runs in-process via node-cron, on UTC schedules** (`CRON_JOBS` in `app.ts`). Hours below are
UTC, chosen to cover the US regular session (13:30–21:00 UTC across EDT/EST). The runtime gate
`isEtRegularSessionOpen` (America/New_York, DST + NYSE holiday + early-close aware since
siglens-core 0.44) tightens execution to the actual session, so out-of-session fires early-return
`market_closed`. That claim used to be aspirational — core computed session state from weekday and
clock only, so Thanksgiving noon read as `open` and a 13:00 half day stayed `open` until 16:00. The
calendar is *computed*, not fetched (`domain/marketCalendar.ts`): every NYSE closure is rule-derived,
so there is no feed to fail. Unscheduled closures (a national day of mourning) are a short literal
list in core and the broker remains the backstop for live orders.
(UTC 13:00–20:59 ≈ KST 22:00–05:59.)

| Analysis type | Schedule (UTC)          | Effective spacing | Rationale |
|---------------|-------------------------|-------------------|-----------|
| technical     | `*/15 13-21 * * 1-5`    | follows timeframe | Horizon-sensitive: a new bar only closes once per timeframe tick. Surplus ticks land in a window that is already covered and collapse (1Hour config → 1 LLM call/hour despite the 15-min schedule). |
| options       | `*/15 13-21 * * 1-5`    | follows timeframe | Same as technical — option-chain snapshots are keyed by hash, so re-analysis before the next bar is pointless. |
| news          | `*/15 13-21 * * 1-5`    | 60 minutes        | Event-driven; major catalysts surface within ~60 min. The extra ticks are retry slots, not extra analyses — the cadence guard drops them before any FMP/LLM call. |
| fundamental   | `0 15-21 * * 1-5`       | 24 hours          | Quarterly filings do not move intraday. Hourly ticks exist only so a single missed tick does not cost the whole day. |
| congress      | `0 16-21 * * 1-5`       | 24 hours          | Same — disclosures lag by weeks, the extra ticks are retries. |
| execute       | `2-59/5 13-21 * * 1-5`  | `execute_interval_min` (기본 10분) | Cron fires every 5 min (`2-59/5` covers every minute the gate accepts, including the `:02` slot a `7-59/5` expression missed); the handler's interval gate decides whether this tick runs. `noOverlap: true` plus a 900s hard run deadline keep two runs from ever overlapping. The `:07` offset gives the top-of-hour analysis crons time to save, so a 60-min setting fires at exactly the old times. |
| reconcile     | `*/10 13-21 * * 1-5`    | 10 minutes        | Order timeout detection + DB consistency; must be more frequent than the order TTL. |
| digest        | `0 1 * * *`             | daily             | Flushes the quiet-hours notification queue at 10:00 KST. **Every day, not weekdays** — Friday-night events must reach the operator on Saturday morning. Deliberately not wrapped in the analysis-cron helper, whose US-session gate would suppress it entirely (01:00 UTC is outside the session). |

### Cadence windows

Cadence is enforced by **clock windows**, not by elapsed time: `lib/analysis/cadence.ts` gives each
type a window size, and `api/cron/_run-analysis-cron.ts` skips a symbol whose newest analysis
already falls in the current window. Elapsed-time checks drift, because an analysis is stamped when
it is *saved* — a 5-minute run starting at :00 is stamped :05, so the :30 tick would see only 25
minutes and skip, silently turning a 30-minute cadence into a 45-minute one. Windows make the guard
indifferent to run duration **as long as the run finishes inside its own window**. A run that
crosses the boundary stamps its last symbols into the *next* window and so consumes it — that
symbol then refreshes at 2× the window.

**심볼은 병렬로 돈다** (`_run-analysis-cron.ts`의 `Promise.all`). 실행 시간이 종목 수에
비례하지 않고 **가장 느린 심볼 하나**로 수렴하므로, 위의 창 넘어감은 종목을 늘려도 다시
나타나지 않는다. 심볼당 상한은 `PER_SYMBOL_MAX_MS`(150초)이고, 한 심볼의 예외는 그 심볼만
`error`로 기록되고 나머지 결과를 버리지 않는다.

그 150초 AbortSignal은 **LLM 호출만** 덮는다 — FMP I/O는 signal을 받지 않고 `fmpGet`의
세마포어 대기에는 타임아웃이 없다. 그래서 심볼 작업 전체를 실행 마감(1200초)으로 한 번 더
감싼다. 이게 없으면 멈춘 심볼 하나가 핸들러를 영영 반환하지 않게 만들고, 락 해제도 감사 행
마감도 없이 node-cron의 `noOverlap`이 그 축의 모든 후속 틱을 프로세스 재시작까지 막는다.

**전 심볼이 실패한 실행은 `completed`가 아니라 `error`다.** 심볼 단위 try/catch를 넣으면서
런 전체가 error가 되는 경로가 사라졌는데, `assessCronHealth`는 error 행만 실패로 세므로
프로바이더 장애가 무음이 됐다. 부분 실패는 종전대로 completed.

**technical은 core 분석 캐시를 우회한다**(`runAnalysis(..., force = true)`). 캐시 키에 입력
해시가 없고 1Hour TTL이 케이던스 창과 같아서, 창마다 부르면 한 번 걸러 캐시 히트가 난다.
히트한 결과의 `analyzedAt`은 최대 1시간 전인데 크론은 저장 시각으로 창을 소비하므로 실제
신규 분석이 2시간에 한 번이 되고, execute가 `source_analyzed_at`으로 재는 나이가 1Hour
한도(2시간)를 넘겨 `stale_analysis` — 그 종목의 청산 평가가 통째로 멈춘다. 호출 빈도는 이미
케이던스 창이 제한하므로 캐시가 더 줄일 것이 없다.

### Reasoning (상세 분석) policy

Per-type, in `ANALYSIS_REASONING` (`lib/analysis/types.ts`): **options only** runs with reasoning
off; technical, news, fundamental and congress keep it on. Reasoning is expensive — measured on
deepseek-v4-flash it pushed a single technical symbol to ~7 minutes (a 148s call truncated to zero
output, then a 269s retry) — which is what parallel symbols and the 1200s run deadline are sized
against. Options stays off because its snapshots are hash-keyed and the narrative adds nothing a
re-analysis before the next bar would use.
