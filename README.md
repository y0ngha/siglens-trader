# siglens-trader

<div align="center">

![AWS](https://img.shields.io/badge/AWS-232F3E?style=flat&logo=amazonaws&logoColor=white)
![Upstash](https://img.shields.io/badge/Upstash-00E9A3?style=flat&logo=upstash&logoColor=white)
![Neon](https://img.shields.io/badge/Neon-00E599?style=flat&logo=neon&logoColor=black)
![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?style=flat&logo=cloudflare&logoColor=white)
![Resend](https://img.shields.io/badge/Resend-000000?style=flat&logo=resend&logoColor=white)

![React](https://img.shields.io/badge/React-19.2-61dafb?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![Node.js](https://img.shields.io/badge/node-%3E%3D25.2.1-green)

## Siglens 분석 사이트 기반 작동

[![Website](https://img.shields.io/badge/Website-siglens.io-blue?style=for-the-badge)](https://siglens.io)
[![GitHub](https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/y0ngha/siglens)


US 주식 자동매매 시스템. **일봉 RSI(2) 눌림매수** 규칙으로 매매하고, AI 분석은 신호가 난 종목에 대해 **기록 전용 리뷰**로만 쓴다.

</div>

## 제품 화면

<p align="center">
  <img src="images/1.png" alt="siglens-trader product screenshot 1" width="48%" />
  <img src="images/2.png" alt="siglens-trader product screenshot 2" width="48%" />
  <img src="images/3.png" alt="siglens-trader product screenshot 3" width="48%" />
  <img src="images/4.png" alt="siglens-trader product screenshot 4" width="48%" />
  <img src="images/5.png" alt="siglens-trader product screenshot 5" width="48%" />
  <img src="images/6.png" alt="siglens-trader product screenshot 6" width="48%" />
</p>

## 문서

- [배포 가이드](docs/DEPLOYMENT.md) / [EC2 운영 런북](infra/aws/README.md)
- [보상 트랜잭션 설계](docs/COMPENSATING_TRANSACTIONS.md)
- **현행 전략**: [일봉 RSI(2) 눌림매수로 전략 교체 (2026-09-24)](docs/specs/2026-09-24-daily-mean-reversion-design.md) — 백테스트 근거, 기각한 대안, 한계
- 과거 설계(1시간봉 종합 점수 시절): [AI 매매 게이트](docs/specs/2026-08-12-ai-trade-gate-design.md) · [지표 컨플루언스 축](docs/specs/2026-08-14-indicator-confluence-signal-design.md) · [진입 시간 창](docs/specs/2026-08-15-entry-window-design.md) · [매매 실행 주기](docs/specs/2026-08-16-execution-cadence-design.md)
- [AWS 이전](docs/specs/2026-07-19-vercel-to-aws-migration-design.md)

## 동작 원리

```
[FMP]                  →  일봉(400일) + 실시간 시세
         ↓
[mean-reversion 규칙]  →  종가 > SMA200 · RSI(2) < 10 · SPY > SMA200 → 매수
                          종가 > SMA5 · 10거래일 · 재난 손절(진입가 − 5×ATR) → 청산
                          판단은 장 마감 20분 전 하루 1회, 재난 손절만 매 틱
         ↓
[Toss Securities API]  →  주문 실행 (auto 모드일 때만, 멱등성 키 + 주문 추적)
         ↓
[review cron]          →  신호 종목만 기술(일봉)·뉴스·펀더멘털 분석 + "악재성 하락인가" AI 판단을 기록 (주문 무관)
[reconcile cron]       →  미체결 주문 타임아웃 + 자동 복구 + DB 정합성 검사 (10분 간격)
```

### 왜 이 규칙인가

종전 1시간봉 종합 점수(6축 가중평균) 전략은 8회전 1승이었고, 백테스트에서 비용 포함 거래당 −0.25~−0.30%의
구조적 손실이었다. 점수는 다음 날 수익률과 오히려 역상관이었다. RSI(2) 눌림매수는 12년 · 성장주 16 / 부진주 22 /
ETF 4 전부에서 같은 청산 규칙의 기준선보다 우위였고 승률 60~72%였다(부진주는 비용 차감 후 절대 수익 ≈ 0).
전문은 [스펙](docs/specs/2026-09-24-daily-mean-reversion-design.md).

## 매매 모드

| 모드 | 동작 |
|------|------|
| `dry_run` | 실제 주문 없음. 가상 거래만 DB에 기록. |
| `semi_auto` | 신호 발생 시 이메일 알림 → 대시보드에서 승인/거절 (대기 주문 TTL 15분) |
| `auto` | 즉시 주문 실행 |

모든 거래에는 규칙의 판단 근거(reason — RSI(2), SMA200, 발동한 청산 규칙)가, 모든 판단 틱에는 `cron_decisions.detail.mr`이, 모든 신호에는 AI 리뷰가 남는다.

## 실행 주기

cron은 node-cron으로 **인프로세스** 실행된다(UTC 스케줄, `server/app.ts`의 `CRON_JOBS`). 정규장 밖 발사는 `isEtRegularSessionOpen` 게이트가 `market_closed`로 조기 반환한다 — NYSE 휴장일과 13:00 반장까지 계산으로 판정한다.

| cron | 스케줄 (UTC) | 실효 주기 |
|------|-------------|-----------|
| execute | `2-59/5 13-21 * * 1-5` | `execute_interval_min` (5/10, 기본 **10분**) — 재난 손절은 매 틱, 진입·규칙 청산은 마감 20분 전 하루 1회 |
| reconcile | `*/10 13-21 * * 1-5` | 10분 (장 마감·휴장일에도 계속 — 주문 사후 처리는 장과 무관) |
| digest | `0 1 * * *` | 매일 (주말 포함) — quiet hours 큐 발송 + cron 이상 감지 |
| review | `*/10 16-21 * * 1-5` | 오늘의 신호를 AI가 리뷰해 기록 (신호가 없으면 아무것도 안 함) |

## 안전 장치

| 장치 | 설명 |
|------|------|
| 킬 스위치 | `trading_enabled=false`로 **청산 포함 전부** 즉시 중단 (루프 중간에도 재확인) |
| 일일 거래 한도 | `max_trades_per_day`(기본 20) 초과 시 **신규 진입만** 차단 |
| 일일 손실 한도 | 오늘 실현 손실 + 보유 포지션의 **오늘** 변동분이 `max_daily_loss_usd`(기본 500) 초과 시 진입 차단 + 이메일(하루 1회) |
| 재난 손절 | 진입가 − `mr_stop_atr`(기본 5) × ATR(14). 매 틱 확인, 일봉 조회가 실패해도 작동 |
| 시장 국면 필터 | SPY가 200일선 아래면 신규 진입 없음 (`mr_regime_filter`) |
| 종목별/총 노출 한도 | `max_position_size` / `max_total_exposure` — **원가(투자 금액) 기준**. 평가액 기준이면 가격이 내릴수록 예산이 커진다 |
| 분산 락 | Redis SETNX + UUID 소유자 검증 + Lua 스크립트 해제 (execute·review 락 TTL 30분) |
| 실행 데드라인 | execute 900초, review 1200초 — 플랫폼이 아니라 코드가 정한 상한 |
| 멱등성 키 | `{cronRunId}-{symbol}-{side}` 형식으로 중복 주문 방지 |
| 주문 추적 | `order_tracking` 테이블로 submitted → filled/rejected/timeout 전체 라이프사이클 관리 |
| 정합성 검사 | reconcile cron이 10분마다 미체결 타임아웃(30분) + 자동 복구 + DB 일관성 확인 |
| cron 감사 로그 | `cron_runs` / `cron_decisions`에 실행·판단 근거 기록. 15분 넘게 `running`인 행은 다음 실행이 `error`로 마감 |
| cron 이상 감지 | digest cron이 24시간 내 실패 / 72시간 침묵 / 100시간 동안 판단 단계 없음을 감지해 알림 (정상이면 침묵) |
| 같은 날 재매수 방지 | 이 실행에서 판 종목은 그날 다시 사지 않는다 |
| 매도 중복 방지 | 이미 submitted 상태인 매도 주문이 있는 종목은 추가 매도 차단 |
| DB 트랜잭션 | 거래+포지션 변경은 반드시 트랜잭션 내에서 원자적으로 실행 |
| NaN 방어 | `isFinitePositive`, `safeNumber`, `safe-extract` 모듈로 AI 결과의 NaN/Infinity 전파 차단 |
| 부분 체결 | `reducePositionQuantity`로 부분 매도 시 포지션 수량만 감소 |

**리스크 차단기는 새 리스크만 막고, 리스크 축소는 절대 막지 않는다.** 킬 스위치만 예외로 전부를 멈춘다.

## 알림

Resend로 이메일 발송. **00:00–09:59 KST(quiet hours)** 사이에 발생한 알림은 `notification_queue`에 쌓였다가 digest cron이 10:00 KST에 한 통으로 보낸다. 이벤트별 on/off는 **설정 > 알림**에서 조정한다(거래 체결, 주문 승인 대기, 손절 발동, 시스템 오류, 시스템 이상 감지). 채널이나 이벤트가 꺼져 있으면 큐에도 쌓이지 않는다.

## 인증

자체 로그인이 기본 경로다. `POST /api/auth/login`이 bcrypt(cost 12)로 비밀번호를 검증하고 `trader_session` HttpOnly 쿠키를 발급한다. **가입 엔드포인트는 없다** — 계정은 `yarn db:seed-operator`로만 만든다.

Cloudflare Access JWT(`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`)도 병행 지원한다. 헤더만 믿는 폴백은 없다 — Access를 걷어내면 오리진이 직접 노출되므로 위조 헤더가 곧 인증 우회다. 로컬 개발은 `DISABLE_AUTH=true`(프로덕션에서는 무시).

## 기술 스택

- **Frontend**: React 19 + Vite (PWA), TanStack Query, Tailwind CSS v4
- **Backend**: Hono (Node) on AWS EC2 — 정적 SPA + `/api` 라우트 + 인프로세스 node-cron, Docker/ECR 배포
- **DB**: Neon PostgreSQL + Drizzle ORM (16 테이블)
- **분석**: [@y0ngha/siglens-core](https://github.com/y0ngha/siglens-core) `0.47.0` (LLM 호출은 앱 프로세스 내부)
- **데이터**: FMP API, Yahoo Finance (yahoo-finance2)
- **인증**: 자체 로그인 (bcrypt + 세션 쿠키, 회원가입 없음) — Cloudflare Access JWT도 병행 지원
- **알림**: Resend (Email)
- **락**: Upstash Redis (distributed lock, SETNX + Lua release)
- **테스트**: Vitest + MSW (Mock Service Worker), 2036개 테스트
- **패키지 매니저**: Yarn 4

## 필요한 외부 서비스

| 서비스 | 용도 | 비고 |
|--------|------|------|
| FMP API | 가격·바·뉴스·펀더멘털·의회공시 | [financialmodelingprep.com](https://financialmodelingprep.com) |
| Yahoo Finance | 옵션 체인 데이터 | yahoo-finance2 npm 패키지 |
| LLM 제공사 | 신호 종목의 분석 + AI 리뷰 (기록 전용) | DeepSeek / Anthropic / Google / OpenAI — 설정한 모델의 키만 있으면 된다 |
| Upstash Redis | 분산 락 + 토스 OAuth 토큰·accountSeq 캐시 + core 내부 캐시 | |
| Neon DB | 상태/이력 저장 | PostgreSQL |
| Toss Securities | 주문 실행 | Open API (OAuth2 client_credentials, 개인용) |
| Resend | 이메일 알림 | |
| Cloudflare | DNS + Access 인증 + Tunnel(유일한 인그레스) | |
| GitHub Packages | `@y0ngha/siglens-core` 설치 | `read:packages` 토큰 필요 (`SIGLENS_GITHUB_TOKEN`) |

## 실행

`@y0ngha/siglens-core`는 GitHub Packages에서 받으므로, `yarn install` 전에 `SIGLENS_GITHUB_TOKEN`(`read:packages` 스코프)이 환경에 있어야 한다 — `.yarnrc.yml`이 이 값을 읽는다.

```bash
# 의존성 설치
yarn install

# 개발 서버 (대시보드)
yarn dev              # 포트 6270
yarn dev:mock         # MSW mock 모드 — 백엔드 없이 UI 개발

# 서버 (Hono + cron) — 컨테이너가 실제로 돌리는 것
yarn start

# 빌드 / 타입 / 린트
yarn build
yarn typecheck
yarn lint          # lint:fix, lint:style, lint:style-fix

# 테스트
yarn test          # test:watch, test:coverage

# 포맷
yarn format        # format:check

# DB
yarn db:generate       # 스키마 변경 → 마이그레이션 생성
yarn db:migrate        # 마이그레이션 실행
yarn db:seed-operator  # 운영자 계정 생성 (유일한 계정 생성 경로)
yarn db:seed           # Mock 데이터 삽입
yarn db:clear          # 전체 데이터 삭제 (확인 프롬프트 있음)

# 릴리스 = 배포 트리거 (v* 태그 푸시가 .github/workflows/deploy.yml 실행)
yarn release --ci
```

## 환경변수

`.env.example` 참고. 주요 항목:

```
DISABLE_AUTH=          # true면 로컬에서 로그인 없이 개발 (프로덕션에서는 무시)
OPERATOR_EMAIL=        # yarn db:seed-operator 전용 — 운영자 계정 생성/비밀번호 회전
OPERATOR_PASSWORD=
CF_ACCESS_TEAM_DOMAIN= # Cloudflare Access JWT 검증 (선택)
CF_ACCESS_AUD=
DATABASE_URL=          # Neon PostgreSQL
UPSTASH_REDIS_REST_URL= # 토스 OAuth 토큰 캐시 + accountSeq 캐시 + 분산 락 (trading 필수)
UPSTASH_REDIS_REST_TOKEN=
FMP_API_KEY=           # 시장 데이터
MARKET_DATA_PROVIDER=fmp
DEEPSEEK_API_KEY=      # 기본 분석 모델 + 뉴스 카드 요약
ANTHROPIC_API_KEY=     # 설정한 모델의 키만 있으면 된다
GEMINI_API_KEY=
OPENAI_API_KEY=
TOSS_APP_KEY=          # 토스증권 OAuth2 client_id (auto/semi_auto 필수)
TOSS_SECRET_KEY=       # 토스증권 OAuth2 client_secret
CRON_SECRET=           # cron 인증 (미설정 시 스케줄러 비활성)
RESEND_API_KEY=        # 이메일 알림
NOTIFICATION_EMAIL_FROM=noreply@siglens.io
TUNNEL_TOKEN=          # Cloudflare Tunnel (AWS 배포 전용, 인스턴스의 유일한 인그레스)
SIGLENS_GITHUB_TOKEN=  # GitHub Packages read:packages — yarn install에 필요
```

## 라이선스

MITLicense

## 면책 고지

본 서비스는 Siglens의 분석 결과를 바탕으로 이용자가 설정한 값에 따라 자동 매매를 진행하는 서비스입니다. 모든 투자 판단, 설정값 구성, 자동 매매 실행 및 그 결과에 대한 책임은 이용자 본인에게 있으며, Siglens 및 Siglens Trader는 투자 손실이나 기타 불이익에 대해 책임을 지지 않습니다.
