# server/ — Hono app + in-process cron

`index.ts` boots the HTTP server and `startCron()`; `app.ts` mounts every `api/` handler on a Hono
route and registers the node-cron tasks in `CRON_JOBS`. Handler logic lives in `api/` — this
directory only decides **when** and **where** it runs.

Graceful shutdown stops the cron tasks, drains HTTP, and hard-exits after 25s. It does **not**
release Redis locks: a run killed mid-flight leaves its lock held until the TTL (30 min for the
analysis and execute crons), so a deploy during the session can cost that much cron downtime.

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
| news          | `0 13-21 * * 1-5`       | 60 minutes        | Event-driven; major catalysts surface within ~60 min of publication. FMP news endpoint is heavily rate-limited. |
| fundamental   | `0 15 * * 1-5`          | 24 hours          | Quarterly filings and earnings do not move intraday; daily is more than sufficient. |
| congress      | `0 16 * * 1-5`          | 24 hours          | Congressional disclosures lag the actual trade by weeks; once per weekday is plenty. |
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
나타나지 않는다. 심볼당 상한은 여전히 `PER_SYMBOL_MAX_MS`(150초)이고, 한 심볼의 예외는
그 심볼만 `error`로 기록되고 나머지 결과를 버리지 않는다.

### Reasoning (상세 분석) policy

Per-type, in `ANALYSIS_REASONING` (`lib/analysis/types.ts`): **options only** runs with reasoning
off; technical, news, fundamental and congress keep it on. Reasoning is expensive — measured on
deepseek-v4-flash it pushed a single technical symbol to ~7 minutes (a 148s call truncated to zero
output, then a 269s retry) — which is what parallel symbols and the 1200s run deadline are sized
against. Options stays off because its snapshots are hash-keyed and the narrative adds nothing a
re-analysis before the next bar would use.
