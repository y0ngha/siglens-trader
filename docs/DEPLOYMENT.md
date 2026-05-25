# 배포 가이드

siglens-trader를 프로덕션에 배포하기 위한 인프라 셋업 순서.

---

## 1. Neon DB 생성

1. [neon.tech](https://neon.tech) 로그인
2. 새 프로젝트 생성 (또는 기존 프로젝트에 새 database)
   - Database name: `siglens_trader`
   - Region: `us-east-2` (Vercel과 같은 리전 권장)
3. Connection string 복사 → `DATABASE_URL`로 사용

```bash
# 로컬에서 마이그레이션 실행
echo "DATABASE_URL=postgresql://..." > .env.local
yarn db:migrate
```

---

## 2. Vercel 프로젝트 연결

1. [vercel.com](https://vercel.com) → New Project → Import Git Repository
   - Repository: `y0ngha/siglens-trader`
   - Framework: Vite
   - Root Directory: `.`
   - Build Command: `tsc -b && vite build`
   - Output Directory: `dist`

2. Environment Variables 설정 (Vercel Dashboard → Settings → Environment Variables):

```
# 필수
DATABASE_URL=postgresql://...
CRON_SECRET=<generate random string>
UPSTASH_REDIS_REST_URL=<from siglens>
UPSTASH_REDIS_REST_TOKEN=<from siglens>
WORKER_URL=<siglens-worker URL>
WORKER_SECRET=<from siglens-worker>
FMP_API_KEY=<from financialmodelingprep.com>
MARKET_DATA_PROVIDER=fmp

# BYOK (선택 — 대시보드에서 활성화 시 필요)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=

# 알림
RESEND_API_KEY=<from resend.com>
NOTIFICATION_EMAIL_FROM=noreply@siglens.io

# 토스증권 (API 오픈 후 설정)
TOSS_APP_KEY=
TOSS_SECRET_KEY=
TOSS_ACCOUNT_NO=
```

3. Deploy → 첫 배포 완료

---

## 3. Vercel Cron 확인

`vercel.json`에 정의된 cron은 배포 시 자동 등록됨:

| Cron | 스케줄 | 역할 |
|------|--------|------|
| `/api/cron/technical` | 매시 정각 (US 장중) | 기술적 분석 |
| `/api/cron/news` | 매시 정각 | 뉴스 분석 |
| `/api/cron/options` | 매시 정각 | 옵션 분석 |
| `/api/cron/fundamental` | 하루 1회 (KST 22:00) | 펀더멘털 분석 |
| `/api/cron/execute` | 매시 7분 (분석 후 offset) | 매매 판단/실행 (분산 락 사용) |
| `/api/cron/reconcile` | 10분 간격 | 미체결 주문 타임아웃(30분) + DB 정합성 검사 |

스케줄 상세: `0 22-23,0-5 * * 1-5` (KST 22:00~05:59, 월~금 = US 장중)
reconcile: `*/10 22-23,0-5 * * 1-5` (10분 간격, 장중 시간대)

Vercel Dashboard → Cron Jobs 탭에서 실행 상태 확인 가능.

**CRON_SECRET 설정 확인**: Vercel이 cron 호출 시 `Authorization: Bearer <CRON_SECRET>` 헤더를 보냄. 이 값이 환경변수와 일치해야 cron이 동작함.

---

## 4. Cloudflare DNS 설정

1. Cloudflare Dashboard → DNS → Add Record
   - Type: `CNAME`
   - Name: `auto-trade`
   - Target: `cname.vercel-dns.com`
   - Proxy: **ON** (주황색 구름)

2. Vercel Dashboard → Domains → Add Domain
   - `auto-trade.siglens.io` 추가
   - Cloudflare 프록시가 켜져있으면 Vercel이 SSL을 자동 처리

---

## 5. Cloudflare Access (Zero Trust) 설정

외부 접근을 완전히 차단하고, 본인만 접근 가능하게.

1. Cloudflare Dashboard → Zero Trust → Access → Applications
2. **Add an Application** → Self-hosted
   - Application name: `SigLens Trader`
   - Session Duration: `7 days`
   - Application domain: `auto-trade.siglens.io`
   - Path: (비워두기 — 전체 도메인)

3. **Add a Policy**
   - Policy name: `Owner Only`
   - Action: **Allow**
   - Include rule: `Emails` → `dev.y0ngha@gmail.com`

4. 인증 방법: **One-time PIN** (이메일 OTP)
   - 접속 시 이메일로 6자리 코드 발송 → 입력하면 7일간 유효

**API 인증 체계**: 인증된 사용자는 `cf-access-authenticated-user-email` 헤더가 설정됨. `api/_lib/auth.ts`에서 이 헤더로 인증 여부를 판단. 로컬 개발 시 `DISABLE_AUTH=true`를 `.env.local`에 설정하면 인증 없이 API 사용 가능.

---

## 6. Resend 설정 (이메일 알림)

1. [resend.com](https://resend.com) → API Keys → Create
2. Domains → `siglens.io` (이미 등록되어있으면 그대로 사용)
3. 발신 주소: `noreply@siglens.io`
4. Vercel에 `RESEND_API_KEY` 환경변수 설정

---

## 7. 초기 데이터 설정

배포 후 처음에는 DB가 비어있음. 두 가지 방법:

**A. Mock 데이터로 시작 (테스트용)**
```bash
yarn db:seed
```

**B. 빈 상태로 시작 (프로덕션)**
- 대시보드 접속 → 설정 → 감시 종목 추가
- Cron이 자동으로 분석 실행 시작

**데이터 초기화:**
```bash
yarn db:clear    # 모든 테이블 데이터 삭제 (확인 프롬프트)
```

---

## 8. 점검 체크리스트

| 항목 | 확인 방법 |
|------|-----------|
| 대시보드 접속 | `https://auto-trade.siglens.io` → Cloudflare OTP 인증 후 UI 표시 |
| Cron 동작 | Vercel Dashboard → Cron Jobs → 다음 실행 시간 확인 |
| DB 연결 | 대시보드 상태 페이지에 데이터 표시 |
| 분석 연동 | `/api/cron/technical` 수동 호출 (curl + CRON_SECRET) 후 분석 결과 확인 |
| 이메일 알림 | 설정에서 테스트 이메일 발송 |

**수동 Cron 테스트:**
```bash
curl -H "Authorization: Bearer <CRON_SECRET>" \
     https://auto-trade.siglens.io/api/cron/technical
```

---

## 9. 운영 모드 전환

1. 초기: `dry_run` (모의투자) — 실제 주문 없이 가상 거래 기록
2. 검증 후: `semi_auto` — 신호 발생 시 이메일 알림, 대시보드에서 승인
3. 신뢰도 확보 후: `auto` — 자동 주문 실행 (토스 API 필요)

대시보드 설정 페이지에서 변경하거나:
```sql
UPDATE config SET value = '"semi_auto"' WHERE key = 'trading_mode';
```

---

## 10. API 엔드포인트

### Dashboard API (인증 필요)

| Method | Path | 역할 |
|--------|------|------|
| GET | `/api/status` | 시스템 상태 |
| GET | `/api/positions` | 보유 포지션 |
| POST | `/api/positions/:id/close` | 수동 포지션 청산 (atomic) |
| GET | `/api/trades` | 거래 내역 |
| GET | `/api/analysis?symbol=` | 분석 결과 조회 |
| POST | `/api/analysis/trigger` | 수동 분석 트리거 |
| GET | `/api/config` | 전체 설정 조회 |
| POST | `/api/config` | 설정 변경 (allowlist 검증) |
| GET | `/api/pending` | 승인 대기 주문 |
| POST | `/api/approve/:id` | 주문 승인/거절 |
| GET | `/api/search?q=` | 종목 검색 (FMP) |
| GET | `/api/health` | 헬스체크 (인증 불필요, `?deep=true`로 DB 정합성 포함) |

### Cron API (CRON_SECRET 인증)

| Method | Path | 역할 |
|--------|------|------|
| GET | `/api/cron/technical` | 기술적 분석 실행 |
| GET | `/api/cron/news` | 뉴스 분석 실행 |
| GET | `/api/cron/options` | 옵션 분석 실행 |
| GET | `/api/cron/fundamental` | 펀더멘털 분석 실행 |
| GET | `/api/cron/execute` | 매매 판단 + 실행 (분산 락, 서킷 브레이커 포함) |
| GET | `/api/cron/reconcile` | 미체결 주문 타임아웃 + DB 정합성 검사 |

---

## 11. 새 환경변수 (감사 후 추가)

execute cron과 reconcile cron에서 사용하는 설정값은 DB `config` 테이블에 저장된다:

| Config Key | 기본값 | 설명 |
|------------|--------|------|
| `trading_enabled` | `true` | 킬 스위치 — `false`면 모든 매매 즉시 중단 |
| `max_trades_per_day` | `20` | 일일 최대 거래 횟수 |
| `max_daily_loss_usd` | `500` | 일일 최대 허용 손실 (실현 + 미실현 합산) |
| `fixed_exit_enabled` | `false` | 고정 손절/익절 비율 활성화 |

Redis 분산 락을 위해 기존 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`이 반드시 설정되어야 한다. 미설정 시 락이 비활성화되어 동시 실행 위험이 있다 (dev 모드에서는 warning 출력 후 진행).

---

## 12. 마이그레이션 참고

`order_tracking` 테이블이 추가되었다. 배포 전 반드시 마이그레이션을 실행할 것:

```bash
yarn db:migrate
```

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| Cron 401 | CRON_SECRET 불일치 | Vercel env vars 확인 |
| Dashboard 403 | Cloudflare Access 미설정 또는 DISABLE_AUTH 미설정 (로컬) | Zero Trust 정책 확인 / .env.local에 DISABLE_AUTH=true |
| 분석 안 됨 | WORKER_URL/SECRET 미설정 | siglens-worker 정보 확인 |
| 빈 대시보드 | watchlist 비어있음 | 설정에서 종목 추가 |
| 이메일 안 옴 | RESEND_API_KEY 미설정 | Resend 대시보드 확인 |
| Access 거부 | Cloudflare policy 미적용 | Zero Trust 설정 재확인 |
| Config 400 | 허용되지 않은 key | ALLOWED_CONFIG_KEYS 확인 (api/config.ts) |
| Execute skipped (locked) | 이전 execute cron이 아직 실행 중 | Redis 락 TTL (15분) 만료 대기, 또는 수동 키 삭제 |
| Reconcile 이메일 폭발 | 다수 주문 30분 타임아웃 | broker 연결 상태 확인, 수동 주문 상태 업데이트 |
| 일일 손실 한도 초과 | 당일 실현+미실현 손실 합산 초과 | `max_daily_loss_usd` 조정 또는 다음 거래일까지 대기 |
