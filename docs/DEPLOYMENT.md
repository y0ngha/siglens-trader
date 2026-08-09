# 배포 가이드

siglens-trader를 프로덕션에 배포하기 위한 인프라 셋업 순서.

---

## 1. Neon DB 생성

1. [neon.tech](https://neon.tech) 로그인
2. 새 프로젝트 생성 (또는 기존 프로젝트에 새 database)
   - Database name: `siglens_trader`
   - Region: `us-east-2` (앱은 ap-northeast-2에서 돌지만, DB는 기존 리전을 유지한다 — 이관 설계 §10 참고)
3. Connection string 복사 → `DATABASE_URL`로 사용

```bash
# 로컬에서 마이그레이션 실행
echo "DATABASE_URL=postgresql://..." > .env.local
yarn db:migrate
```

---

## 2. AWS 인프라 (최초 1회)

배포 대상은 단일 EC2 + Cloudflare Tunnel. 스크립트와 상세 런북은
[`infra/aws/README.md`](../infra/aws/README.md), 설계 근거는
[`docs/specs/2026-07-19-vercel-to-aws-migration-design.md`](specs/2026-07-19-vercel-to-aws-migration-design.md).

```bash
export AWS_REGION=ap-northeast-2

# 1) IAM: EC2 인스턴스 롤 + GitHub OIDC 배포 롤 (출력된 ARN을 GitHub secret에 등록)
infra/aws/provision-iam.sh

# 2) 시크릿: 로컬 env 파일 → SSM /siglens-trader/* (SecureString)
infra/aws/params.sh .env.production

# 3) 첫 이미지가 ECR에 있어야 인스턴스가 뜬다 (v* 태그를 푸시하거나 수동 build+push)
# 4) ECR·SG·로그·알람·EC2 기동
infra/aws/provision.sh 0.11.0
```

GitHub → Settings → Secrets and variables → Actions:

| Secret | 값 |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `provision-iam.sh`가 출력 |
| `AWS_ACCOUNT_ID` | AWS 계정 번호 |
| `SIGLENS_GITHUB_TOKEN` | GitHub Packages read 토큰 (`@y0ngha/siglens-core` 설치용) |

SSM에 넣을 환경변수는 `.env.example` 참고. Vercel 대시보드 대신 **SSM이 유일한 시크릿 저장소**이며,
컨테이너는 재시작마다 다시 읽는다(`/run`은 tmpfs).

이후 배포는 태그 푸시로 자동화된다:

```bash
yarn release:patch          # v0.11.1 태그 push → .github/workflows/deploy.yml
```

수동 배포·롤백은 `infra/aws/deploy.sh <tag>` (ECR lifecycle이 최근 3개 태그만 보관).

---

## ⚠️ 배포 전 필수: 스키마 마이그레이션

> **auto / semi_auto 모드를 활성화하기 전에 반드시 완료해야 한다.**
> `order_tracking` 테이블에 `client_order_id` 컬럼이 없으면 auto 모드 주문 insert가 모두 실패한다.

`drizzle/` 디렉터리는 버전관리에 포함되어 있으며 `yarn db:migrate`는 FRESH DB에서도 정상 동작한다 (0004 마이그레이션에 `IF NOT EXISTS` 적용).

**방법 A — yarn db:migrate (권장, FRESH/기존 DB 모두 동작)**
```bash
DATABASE_URL=postgresql://<prod-connection-string> yarn db:migrate
```

**방법 B — 수동 SQL (idempotent 보조 수단)**

기존 DB에 컬럼이 없는 경우 수동으로 적용할 수 있는 idempotent ALTERs:
```sql
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS client_order_id text;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS client_order_id text;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS realized_pnl numeric;
```

**적용 확인:**
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'order_tracking' AND column_name = 'client_order_id';
-- 1행이 반환되면 정상
```

---

## 안전 롤아웃 순서

1. **환경변수 설정** — 위 env 목록 전체 (Redis + Toss 키 포함) 입력 후 저장
2. **스키마 마이그레이션** — 위 단계로 `client_order_id` 컬럼 존재 확인
3. **`dry_run` 배포** (기본값) — 실제 주문 없이 한 세션(1~2 거래일) 운영하며 로그·DB 확인
4. **`semi_auto` 전환** — 신호 발생 시 이메일 수신 + 대시보드 승인으로 실제 Toss 주문 경로 검증 (한 세션)
5. **`auto` 전환** — `semi_auto` 세션이 정상 완료된 후에만 활성화. 초기에는 `max_trades_per_day`, `max_position_size`, `max_daily_loss_usd`를 보수적으로 설정

```sql
-- 모드 전환 예시
UPDATE config SET value = '"semi_auto"' WHERE key = 'trading_mode';
UPDATE config SET value = '3' WHERE key = 'max_trades_per_day';
```

---

## 3. Cron 확인

cron은 앱 프로세스 안에서 `node-cron`으로 돈다(`server/app.ts`의 `CRON_JOBS`). 별도 등록 절차 없음 —
컨테이너가 떠 있으면 스케줄도 살아 있다.

| Cron | 스케줄 (UTC) | 역할 |
|------|--------|------|
| technical | `0 13-21 * * 1-5` | 기술적 분석 |
| news | `0 13-21 * * 1-5` | 뉴스 분석 |
| options | `0 13-21 * * 1-5` | 옵션 분석 |
| fundamental | `0 15 * * 1-5` | 펀더멘털 분석 |
| execute | `7 13-21 * * 1-5` | 매매 판단/실행 (분산 락) |
| reconcile | `*/10 13-21 * * 1-5` | 미체결 주문 타임아웃 + DB 정합성 |

UTC 13~21시 = KST 22:00~06:59. 실제 실행은 런타임 게이트 `isEtRegularSessionOpen`이
미국 정규장으로 다시 좁힌다(장외 발화는 `market_closed`로 조기 종료).

- `CRON_SECRET`은 여전히 필요하다. 스케줄러가 각 잡을 `Authorization: Bearer <CRON_SECRET>`을 실은
  요청으로 호출하므로, 미설정 시 스케줄러가 경고를 남기고 **비활성**된다.
- `/api/cron/*` 엔드포인트도 살아 있어 수동 트리거가 가능하다(같은 시크릿으로 인증).
- 실행 이력: 대시보드 Cron Runs 탭, 또는 `aws logs tail /siglens-trader/app --follow`.
- cron 실패는 SNS 알람(`siglens-trader-alerts`)으로 통지된다 — 박스가 정상이어도 매매만 멈추는
  경로라 별도로 감시한다.

---

## 4. Cloudflare Tunnel + DNS

인스턴스는 인바운드 포트를 열지 않는다. `cloudflared`가 아웃바운드로 터널을 맺고
Cloudflare가 그 터널로 트래픽을 보낸다(오리진 인증서·Elastic IP 불필요).

1. Cloudflare Dashboard → Zero Trust → Networks → Tunnels → **Create a tunnel**
   - 이름: `siglens-trader`
   - 발급된 **토큰**을 `.env.production`의 `TUNNEL_TOKEN`에 넣고 `infra/aws/params.sh`로 SSM에 저장
2. 같은 화면 → Public Hostnames → Add
   - Subdomain `auto-trade`, Domain `siglens.io`
   - Service: `HTTP` → `localhost:3000`
   - CNAME은 Cloudflare가 자동 생성한다(수동 DNS 레코드 추가 불필요)
3. 기존 Cloudflare Access 애플리케이션(`auto-trade.siglens.io`)은 그대로 앞단 인증을 담당한다.

---

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

### API 인증 체계 (JWT 검증)

`api/_lib/auth.ts`의 `isAuthenticated()` 동작:

| 상황 | 동작 |
|------|------|
| `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` 환경변수 설정됨 | `Cf-Access-Jwt-Assertion` JWT 헤더를 JWKS로 검증 (엄격 모드) |
| 위 환경변수 미설정 | `cf-access-authenticated-user-email` 헤더를 신뢰 (fallback, 약한 모드) — `[auth]` 경고 로그 출력 |
| `DISABLE_AUTH=true` (비프로덕션 환경) | 모든 인증 우회 (로컬 개발 전용) |
| `DISABLE_AUTH=true` (프로덕션 환경) | **무시됨** — 프로덕션에서는 DISABLE_AUTH가 동작하지 않음 |

**JWT 검증 활성화 환경변수** (SSM `/siglens-trader/*` — `infra/aws/params.sh`로 주입):

```
# Cloudflare Access JWT 검증 (엄격 모드 — 설정 권장)
CF_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
CF_ACCESS_AUD=<Access Application Audience Tag>

# 선택: 쉼표로 구분된 허용 이메일 목록 (설정 시 이 목록에 없는 이메일은 거부)
CF_ACCESS_ALLOWED_EMAILS=dev.y0ngha@gmail.com
```

`CF_ACCESS_TEAM_DOMAIN`과 `CF_ACCESS_AUD`를 설정하기 전까지는 fallback(헤더 신뢰) 모드로 동작한다. 이 모드는 Cloudflare Access가 정상적으로 설정된 경우 현재 프로덕션 상태를 유지하지만, JWT 검증보다 약하다. **가능한 한 빨리 JWT 검증 환경변수를 설정할 것을 권장한다.**

`CF_ACCESS_AUD`는 Cloudflare Dashboard → Zero Trust → Access → Applications → 해당 앱 → Overview → **Application Audience (AUD) Tag**에서 확인할 수 있다.

로컬 개발 시 `DISABLE_AUTH=true`를 `.env.local`에 설정하면 인증 없이 API 사용 가능 (비프로덕션 환경에서만 동작).

---

## 6. Resend 설정 (이메일 알림)

1. [resend.com](https://resend.com) → API Keys → Create
2. Domains → `siglens.io` (이미 등록되어있으면 그대로 사용)
3. 발신 주소: `noreply@siglens.io`
4. `RESEND_API_KEY`를 SSM에 주입 (`infra/aws/params.sh`)

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
| Cron 동작 | `aws logs tail /siglens-trader/app --follow`에서 `[cron:*]` 로그 확인 |
| DB 연결 | 대시보드 상태 페이지에 데이터 표시 |
| 분석 연동 | `/api/cron/technical` 수동 호출 (curl + CRON_SECRET) 후 분석 결과 확인 |
| 이메일 알림 | 설정에서 테스트 이메일 발송 |

**수동 Cron 테스트:**
```bash
curl -H "Authorization: Bearer <CRON_SECRET>" \
     https://auto-trade.siglens.io/api/cron/technical
```

### 배포 검증 SQL

마이그레이션 + 운영 기본값 시드 적용 후 다음 쿼리로 상태를 확인한다.

```sql
-- 분석 봉 주기 설정 (없으면 execute cron이 1Hour 기본값으로 동작)
SELECT key, value
FROM config
WHERE key = 'analysis_timeframe';

-- 분석 타입별 모델 설정 (enabled/BYOK 여부 확인)
SELECT analysis_type, model_id, enabled, use_byok
FROM analysis_model_config
ORDER BY analysis_type;

-- 15분 이상 'running'에 멈춘 cron 감사 행 (다음 cron 호출이 error/timeout으로 종결시킴)
SELECT run_id, status, outcome, started_at, finished_at
FROM cron_runs
WHERE status = 'running'
  AND started_at < now() - interval '15 minutes';
```

마지막 쿼리가 행을 반환하면 직전 invocation이 finish 행을 쓰기 전에 timeout된 것이다. 다음 cron 호출이 이런 행을 `error` / `timeout`으로 종결시키며(절대 삭제하지 않음), 정상 운영 시에는 0행이어야 한다.

**뉴스 cron 타이밍 참고**: 뉴스 카드 enrich는 심볼당 최신 10건만, 동시성 3의 고정 워커 풀로 처리한다. cron 시작 + 690초가 지나면 새 카드 작업을 더 이상 제출하지 않으며(`maxDuration` 800초 안에서 cron 감사 마감을 보장), 시간이 부족하면 심볼별 집계 뉴스 분석은 건너뛴다.

---

## 9. 운영 모드 전환

안전 롤아웃 순서는 **배포 전 필수 섹션**을 참고. 요약:

1. 초기: `dry_run` (모의투자) — 실제 주문 없이 가상 거래 기록
2. 검증 후: `semi_auto` — 신호 발생 시 이메일 알림, 대시보드에서 승인 (실제 Toss API 호출)
3. 신뢰도 확보 후: `auto` — 즉시 주문 실행 (토스 API + Redis 필수)

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
| `analysis_timeframe` | `1Hour` | 기술적 분석 봉 주기 (`15Min` / `30Min` / `1Hour`만 허용). execute cron의 신선도 판단 기준: 15Min→45분, 30Min→90분, 1Hour→2시간 |

Redis 분산 락을 위해 기존 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`이 반드시 설정되어야 한다. **프로덕션에서 미설정 시 락 획득이 fail-CLOSED(false 반환)되어 모든 execute/reconcile cron이 즉시 종료된다** (동시 실행 방지를 위한 의도된 동작). 개발 환경(dev/test)에서는 warning 출력 후 락 없이 진행한다.

---

## 12. 마이그레이션 참고

`order_tracking` 테이블이 추가되었으며, 이후 `client_order_id TEXT` 컬럼 및 `trades.realized_pnl` 컬럼이 추가되었다.

`drizzle/` 디렉터리는 버전관리에 포함되어 있으며, `yarn db:migrate`는 FRESH DB에서 0000~0006 전체 마이그레이션을 순서대로 적용한다. 배포 전 반드시 마이그레이션을 실행할 것 (자세한 절차는 **배포 전 필수 섹션** 참고):

```bash
DATABASE_URL=postgresql://<prod-connection-string> yarn db:migrate
```

기존 DB에서 컬럼이 누락된 경우의 idempotent 수동 보조 수단:
```sql
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS client_order_id text;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS client_order_id text;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS realized_pnl numeric;
```

---

## 13. Vercel → AWS 컷오버

Vercel에서 AWS로 넘길 때의 순서. 실매매 도구라 **`trading_mode=dry_run` 상태에서 검증한 뒤**
모드를 되돌린다.

1. **사전 준비** — 섹션 2를 끝내고(`provision-iam.sh` → `params.sh` → 첫 이미지 → `provision.sh`),
   섹션 4의 Tunnel을 만들되 **public hostname은 아직 붙이지 않는다**.
2. **인스턴스 검증** — 아직 도메인이 Vercel을 가리키는 동안:
   ```bash
   aws logs tail /siglens-trader/app --follow          # "[server] listening on :3000"
   aws ssm start-session --target <instance-id>        # 필요 시 박스 안에서
   curl -fsS localhost:3000/api/health                 # 박스 안에서만 접근 가능
   ```
3. **매매 정지 상태로 전환** — 대시보드에서 `trading_mode=dry_run` (또는 kill switch).
4. **DNS 전환** — Tunnel의 public hostname `auto-trade.siglens.io` → `http://localhost:3000` 연결.
   Cloudflare가 CNAME을 자동 교체하므로 기존 Vercel 레코드는 대체된다.
5. **실사용 검증** — 브라우저로 접속(Access 인증 통과), 대시보드 로딩, `/api/status`,
   cron 1건 수동 트리거:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://auto-trade.siglens.io/api/cron/technical
   ```
   Cron Runs 탭과 CloudWatch 로그에서 결과 확인.
6. **매매 재개** — 원래 `trading_mode`로 복귀.
7. **정리** — 며칠 안정화 후 Vercel 프로젝트 삭제.

**롤백**: Tunnel의 public hostname을 제거하고 `auto-trade` CNAME을 `cname.vercel-dns.com`으로
되돌리면 즉시 Vercel로 복귀한다(Vercel 프로젝트를 지우기 전까지). 앱 레벨 롤백은
이전 태그로 `infra/aws/deploy.sh <tag>`.

> `vercel.json`은 제거됐다. cron 스케줄·SPA rewrite·noindex 헤더는 이제 `server/app.ts`가
> 담당한다(두 곳에 같은 설정이 남으면 드리프트가 생긴다). Vercel로 되돌려야 한다면
> 해당 커밋을 revert하면 파일이 복구된다.

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| Cron 401 | CRON_SECRET 불일치/미설정 | SSM `/siglens-trader/CRON_SECRET` 확인 (미설정 시 스케줄러 자체가 비활성) |
| Dashboard 403 | Cloudflare Access 미설정 또는 DISABLE_AUTH 미설정 (로컬) | Zero Trust 정책 확인 / .env.local에 DISABLE_AUTH=true (프로덕션에서는 무시됨) |
| Dashboard 403 (JWT) | CF_ACCESS_TEAM_DOMAIN/AUD 설정 후 JWT 검증 실패 | Cf-Access-Jwt-Assertion 헤더 존재 여부 확인, AUD Tag 오타 점검 |
| 분석 안 됨 | LLM API 키 미설정 | ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY 확인 |
| 빈 대시보드 | watchlist 비어있음 | 설정에서 종목 추가 |
| 이메일 안 옴 | RESEND_API_KEY 미설정 | Resend 대시보드 확인 |
| Access 거부 | Cloudflare policy 미적용 | Zero Trust 설정 재확인 |
| Config 400 | 허용되지 않은 key | ALLOWED_CONFIG_KEYS 확인 (api/config.ts) |
| Execute skipped (locked) | 이전 execute cron이 아직 실행 중 | Redis 락 TTL (15분) 만료 대기, 또는 수동 키 삭제 |
| Auto 주문 insert 오류 | `client_order_id` 컬럼 없음 | `ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS client_order_id text;` 실행 후 재배포 |
| Reconcile 이메일 폭발 | 다수 주문 30분 타임아웃 | broker 연결 상태 확인, 수동 주문 상태 업데이트 |
| 일일 손실 한도 초과 | 당일 실현+미실현 손실 합산 초과 | `max_daily_loss_usd` 조정 또는 다음 거래일까지 대기 |
