# TODO

## 단기 (토스 API 오픈 후)

- [ ] 토스증권 Open API 실제 endpoint/응답 형식에 맞춰 `lib/trading/toss-client.ts` 교체
- [ ] 토스 API 인증 플로우 (OAuth, 토큰 갱신) 구현
- [ ] `auto` 모드 실전 테스트 (소액)
- [ ] reconcile cron에서 `getOrderStatus()` 호출하여 submitted 주문의 실제 broker 상태 조회 → 체결/취소 반영
- [ ] reconcile cron에서 `getBalances()` 호출하여 broker 잔고와 DB positions 비교 → 불일치 시 알림
- [ ] Price=0 연속 발생 카운터 — 동일 종목에서 가격 데이터 누락이 N회 연속되면 이메일 에스컬레이션 (현재는 매번 동일한 이메일 발송)
- [ ] `recovery.ts`의 TODO 완성: `filledOrdersWithoutPositions`, `openPositionsWithoutTrades` 체크 구현

## 중기

- [ ] 매매 판단 평가 시스템
  - 사용자가 각 거래의 reason을 보고 "좋은 판단 / 나쁜 판단" 평가 가능하게
  - 평가 데이터를 `trade_evaluations` 테이블에 저장
  - 평가 점수를 대시보드에서 추적 (적중률, 평균 수익률 등)
- [ ] 평가 데이터 기반 AI 고도화
  - 평가가 낮은 패턴을 분석하여 프롬프트/가중치 자동 조정
  - 백테스팅 데이터와 실전 데이터 비교
  - siglens-core 프롬프트에 "과거 실패 패턴" context 추가
- [ ] 백테스팅 모듈 (dry_run 이력 기반 성과 분석)
- [ ] PWA Push Notification (VAPID)
- [ ] 손절/익절 자동 감시 (별도 cron — 현재 execute cron이 포지션 재평가 수행하지만 더 빈번한 감시 필요할 수 있음)
- [ ] 대시보드에서 수익률 차트 / 히스토리 시각화
- [ ] auto 모드 전환 확인 다이얼로그 UI 개선 (현재 브라우저 confirm 사용)

## 감사 완료 항목

10라운드 Opus 4.7 감사에서 수정된 주요 항목 (150건+):

- [x] 분산 락 (Redis SETNX + UUID 소유자 검증 + Lua 스크립트 해제)
- [x] 서킷 브레이커: 킬 스위치, 일일 거래 한도, 일일 손실 한도 (실현 + 미실현)
- [x] 입력 검증: NaN 방어, safe-extract 헬퍼 모듈
- [x] 주문 라이프사이클 추적 (order_tracking 테이블 + 멱등성 키)
- [x] Reconciliation cron (10분 간격, 30분 타임아웃)
- [x] 실시간 가격 조회 (FMP quote API, cron 실행 중 캐싱)
- [x] DB 정합성 검사기 (recovery.ts)
- [x] 포지션 추가 매수 (average_in 액션)
- [x] 부분 체결 처리 (reducePositionQuantity)
- [x] 손절 쿨다운 (같은 cron 실행 내 재매수 방지)
- [x] 종목별 노출 한도
- [x] 매도 중복 방지 (pending sell in-flight 가드)
- [x] DB 트랜잭션 (거래 + 포지션 원자적 처리)
- [x] 거래 기반 PnL 계산 (순현금흐름 → 실현손익 방식으로 변경)
- [x] auto 모드 전환 확인 다이얼로그
- [x] 902개 테스트 (42개 파일)

## 장기

- [ ] 국내 주식 지원 (KRX, 장시간 09:00~15:30 KST)
- [ ] 텔레그램 봇 연동
- [ ] 다중 전략 지원 (모멘텀, 밸류, 스윙 등 전략별 설정)
- [ ] 포트폴리오 최적화 (상관관계 기반 분산)
- [ ] 다중 계좌 지원
