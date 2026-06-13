# Plan: 감사 하드닝 (Critical→Low 전체 수정)

Opus 5개 에이전트 전체 감사에서 나온 모든 findings 수정. 그룹별 구현 → 위험군 Opus 리뷰 → 전체 리뷰 → PR(claude-code-review 액션).

## 공통 원칙
- 매매/주문 로직 변경은 보수적·fail-safe. dry_run 무영향 보장.
- ESM 상대 import `.js` 필수. numeric는 insert 시 `String()`, NaN은 `Number.isFinite` 가드.
- 모든 변경에 테스트 추가/갱신, `yarn typecheck && yarn lint && yarn test` green.

## Group 1 — execute.ts 매매 안전 (Critical 1·2, High 3·4)  [위험군→리뷰]
- **C1 매수여력 가드 fail-closed**: `getBuyingPower().catch(()=>null)` 결과가 null이면(조회 실패) auto 매수를 **건너뛴다**(decision `skipped_no_buying_power`, executed:false). 절대 "가드 비활성화"로 통과시키지 않음. dry_run/semi_auto에는 영향 없음.
- **C2 캐시가격 vs 체결가격 괴리**: auto 체결 후 `remainingBuyingPower`/`currentExposure` 차감을 **요청가격이 아니라 실제 `filledPrice`(가능 시)** 로 한다. average_in 종목 캡을 `min(maxPositionSize - 기존노출, maxTotalExposure - currentExposure)` 로(총노출 제약 포함). 체결 후 `filledPrice*qty`가 캡/현금을 유의하게 초과하면 로그+`needs_review` 경고.
- **H3 일일 거래한도 in-flight 집계**: 신규 쿼리 `getTodayInflightOrderCount`(오늘 order_tracking 중 submitted/pending/partial 카운트) 추가 → 한도 체크 시 `getTodayTradeCount + inflight`로 비교.
- **H4 long/short 부호**: 미실현 손실 계산 `(curPrice-avgP)*qty`를 `pos.side==='short' ? (avgP-curPrice) : (curPrice-avgP)` 로. (현재 long-only지만 방어.)
- 테스트: execute.test에 각 케이스(매수여력 null→매수스킵, in-flight 포함 한도, short 부호) 추가.

## Group 2 — 락 + 승인 킬스위치 (High 5, Medium 8·9)  [위험군→리뷰]
- **H5 락 owner 토큰**: `lib/lock.ts`에서 모듈 전역 Map 제거. `acquireLock`이 owner 토큰을 반환, `releaseLock(key, token)`이 그 토큰으로 Lua release. 호출부(execute/reconcile/_run-analysis-cron) 모두 토큰 캡처→전달로 수정.
- **M9 분석 크론 TTL**: `_run-analysis-cron.ts`의 `acquireLock`에 `780`(execute/reconcile와 동일 상수) 전달.
- **M8 승인 킬스위치**: `api/approve/[id].ts`에서 실행 전 `getConfigValue('trading_enabled')` 확인 → false면 승인/주문 거부(명확한 에러 응답). (sell-no-position insertTrade를 트랜잭션으로 감싸는 정리도 함께.)
- 테스트: lock.test(토큰 기반 release), approve.test(킬스위치 off→거부).

## Group 3 — DB (High 7, Medium 11)  [마이그레이션→리뷰]
- **H7 인덱스 드리프트**: `schema.ts`에 0003 인덱스 4개 선언(`idx_analysis_symbol_type_date`, `idx_positions_symbol_status`, `idx_trades_executed_at`, `idx_pending_orders_status`) — 0003 SQL과 정확히 동일 이름/컬럼. `yarn db:generate` 후 생성 마이그레이션을 prod-안전하게(`CREATE INDEX IF NOT EXISTS`) 조정, 스냅샷이 DB와 일치하도록.
- **M11 recovery NaN**: `recovery.ts`의 맨 `Number()` + `<=0` 가드를 `Number.isFinite(x) && x>0` 로.
- 테스트: queries/recovery 관련 갱신.

## Group 4 — data + analysis (Medium 10, Low 16·17·18)  [최종 리뷰]
- **M10 FMP NaN**: `fmp-market-data-provider.ts` `getQuote`/bar 매퍼에 `isFinitePositive`/finite 검증 → 무효 시 null 반환/행 필터.
- **L18 FMP 200+에러바디**: `fmp-http.ts` 배열 기대 엔드포인트에서 비배열/FMP 에러객체 감지 시 throw(→ runner status:'error'로 표면화).
- **L16 poll 타임아웃**: `poll-until-done.ts` `MAX_POLL_TIME_MS`를 합리적 값(예: 300_000)으로 + `lib/analysis/CLAUDE.md` 문서 동기화.
- **L17 run-overall pending_dependencies**: 깔끔하면 재시도/폴링 보강, 위험하면 의도 주석 명시 후 보고.
- 테스트: 해당 어댑터/러너 테스트 갱신.

## Group 5 — notification + config + frontend (Medium 12, Low 13·14·15)  [최종 리뷰]
- **M12 이메일**: `email.ts` `escapeHtml`에 `'`→`&#39;` 추가, `approveUrl` https/origin 스킴 검증, subject의 symbol 이스케이프.
- **L13 score_weights**: `api/config.ts`에서 합 > 0(가능하면 26 검증) + 미허용 키 거부.
- **L14 queryKey 구조분해**: Status/Positions/Trades/Analysis/App/Settings의 `queryFn`을 `({queryKey,signal})` 패턴으로 통일.
- **L15 Settings 부분실패**: buy/sell 임계치 쌍을 함께 저장하거나 부분 실패를 사용자에게 표시.

## Group 6 — auth JWT 검증 (High 6, Medium DISABLE_AUTH)  [위험군→리뷰, lockout 주의]
- **H6**: `jose` 추가. `api/_lib/auth.ts`에서 `Cf-Access-Jwt-Assertion` JWT를 CF Access JWKS(`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`)로 검증(aud/iss/exp) + 이메일 allowlist. 
  - **lockout 방지**: `CF_ACCESS_TEAM_DOMAIN`·`CF_ACCESS_AUD` env가 설정된 경우에만 JWT 검증(fail-closed). 미설정 시 기존 헤더 체크로 폴백(하위호환) — 단, 배포 전 env 설정해야 실제로 닫힘을 문서화.
  - `DISABLE_AUTH`는 `VERCEL_ENV !== 'production'`(또는 NODE_ENV)일 때만 허용.
- 테스트: auth.test(유효/무효 JWT, allowlist, env 미설정 폴백, DISABLE_AUTH prod 차단).

## 의도적 미수정 (by-design)
- 이메일 master OFF가 안전 알림도 끄는 것: 사용자 요청 기반 의도된 동작. 유지.

## 마무리
- 전체 Opus 리뷰 → 수정 → PR → claude-code-review 액션 사이클(자동 반영) → 머지.
- 배포: 머지 후 `yarn release:minor` + prod DB `db:migrate`(0007 + 신규 인덱스 마이그레이션).
