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

## 정적 서빙과 캐시

`/assets/*`는 **SPA 폴백에서 제외한다.** 없는 해시 자산까지 `index.html`을 돌려주면
브라우저는 200 + `text/html`을 받고 `import()`가 "Failed to fetch dynamically imported
module"로 실패한다 — 원인이 "청크 없음"이 아니라 "모듈 파싱 실패"로 위장된다. 404를 주면
브라우저가 사실을 그대로 보고, `src/lib/chunk-recovery.ts`가 한 번 새로고침해 새 문서를 받는다.

캐시 헤더는 **명시한다.** 종전에는 아무것도 붙이지 않아 Cloudflare가 스스로 판단했고
(자산에 `max-age=14400`), 그 결과 폴백이 잘못 내려준 HTML 응답까지 4시간 캐시돼
재배포로도 낫지 않았다.

| 경로 | 정책 | 이유 |
|---|---|---|
| `/assets/*` | `max-age=31536000, immutable` | 파일명에 콘텐츠 해시 — 같은 이름이면 같은 내용 |
| SPA 문서 | `no-cache, must-revalidate` | 이 문서가 어떤 청크를 부를지 정한다. 옛 문서가 살면 새 자산을 영영 못 찾는다 |

**헤더는 `onFound`에서 `c.res`를 갈아끼워 얹는다.** 자연스러운 방법 셋이 전부 실패한다 —
정적 서빙 앞의 `c.header()`는 `serveStatic`이 자체 응답을 만들며 버리고, `await next()` 뒤의
사후 처리는 아예 실행되지 않으며(체인이 끝난다), `onFound` 안의 `c.header()`도 응답 객체가
그 호출 전에 만들어져 무시된다.

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

| Job | Schedule (UTC) | Effective spacing | Rationale |
|-----|----------------|-------------------|-----------|
| execute | `2-59/5 13-21 * * 1-5` | `execute_interval_min` (5 or 10) | Cron fires every 5 min (`2-59/5` covers every minute the gate accepts); the handler's interval gate decides whether this tick runs. Every run checks the disaster stops; the **decision phase** (entries + rule exits) runs once a day on the first tick in the last 20 minutes before the close — 13–21 UTC covers that window in both EDT and EST, and early closes move it to 12:40 ET. `noOverlap: true` plus a 900s hard run deadline keep two runs from ever overlapping. |
| reconcile | `*/10 13-21 * * 1-5` | 10 minutes | Order timeout detection + DB consistency; must be more frequent than the order TTL. |
| digest | `0 1 * * *` | daily | Flushes the quiet-hours notification queue at 10:00 KST and runs the cron-health check. **Every day, not weekdays** — Friday-night events must reach the operator on Saturday morning. |
| review | `*/10 16-21 * * 1-5` | 10 minutes | Record-only AI review of today's signals (`api/cron/review.ts`). Starts at 16 UTC so an early-close decision (12:40 ET = 16:40 UTC in EST) is covered. A tick with nothing to review writes no audit row. |

The five hourly analysis crons (technical / news / options / fundamental / congress) and their cadence windows were
removed on 2026-09-24 with the move to the daily RSI(2) rule
([`docs/specs/2026-09-24-daily-mean-reversion-design.md`](../docs/specs/2026-09-24-daily-mean-reversion-design.md)).
AI analysis now runs only inside `review`, only for symbols that signalled, with reasoning off.
