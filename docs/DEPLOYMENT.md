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
   - Build Command: `vite build`
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
| `/api/cron/technical` | 15분마다 (US 장중) | 기술적 분석 |
| `/api/cron/news` | 15분마다 | 뉴스 분석 |
| `/api/cron/options` | 15분마다 | 옵션 분석 |
| `/api/cron/fundamental` | 하루 1회 (장 시작) | 펀더멘털 분석 |
| `/api/cron/execute` | 15분마다 +7분 offset | 매매 판단/실행 |

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

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| Cron 401 | CRON_SECRET 불일치 | Vercel env vars 확인 |
| 분석 안 됨 | WORKER_URL/SECRET 미설정 | siglens-worker 정보 확인 |
| 빈 대시보드 | watchlist 비어있음 | 설정에서 종목 추가 |
| 이메일 안 옴 | RESEND_API_KEY 미설정 | Resend 대시보드 확인 |
| Access 거부 | Cloudflare policy 미적용 | Zero Trust 설정 재확인 |
