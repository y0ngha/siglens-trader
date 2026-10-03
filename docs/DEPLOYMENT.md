# 배포 가이드

siglens-trader를 프로덕션에 배포하기 위한 인프라 셋업 순서.

---

## 1. PostgreSQL 준비 (Neon 또는 AWS RDS)

DB 드라이버는 `pg`(node-postgres)다. 표준 Postgres 와이어 프로토콜이라 Neon과 RDS 어디에나 붙는다.
현재 운영 DB는 Neon이고, 같은 VPC의 private RDS PostgreSQL 17로 옮기는 중이다
(컷오버 런북은 siglens 레포 `docs/architecture/RDS_MIGRATION.md`).

**Neon (현재)**

1. [neon.tech](https://neon.tech) 로그인
2. 새 프로젝트 생성 (또는 기존 프로젝트에 새 database)
   - Database name: `siglens_trader`
   - Region: `us-east-2` (앱은 ap-northeast-2에서 돌지만, DB는 기존 리전을 유지한다 — 이관 설계 §10 참고)
3. Connection string 복사 → `DATABASE_URL`로 사용

**AWS RDS (이전 대상)**

- private subnet의 RDS PostgreSQL 17. 앱 EC2의 보안 그룹에서 5432만 열어 둔다(외부 노출 없음).
- **앱(컨테이너)용** `DATABASE_URL=postgresql://<user>:<password>@<endpoint>:5432/<db>` — `sslmode`는 안 써도 된다.
  운영 이미지에 RDS 루트 CA 번들이 들어 있고(`certs/rds-global-bundle.pem` → `Dockerfile`의
  `NODE_EXTRA_CA_CERTS`), 서버 인증서를 검증한다.

**TLS 규칙 (`lib/db/connection-config.ts`)**

- 접속 대상(URL 호스트 + `host`/`hostaddr` 쿼리 값)이 **전부** `localhost`/`127.0.0.1`/`::1`/소켓 경로일 때만 로컬이며,
  이때는 URL을 그대로 쓴다(개발용 docker Postgres는 TLS가 없다). `sslmode`도 pg 기본 해석을 따른다.
- 그 외는 URL의 `sslmode` 값과 무관하게 **인증서·호스트명을 검증하는 TLS**를 강제한다.
  `sslmode=disable`/`no-verify`는 에러로 거부한다. `channel_binding=require`(Neon 콘솔 URL에 붙음)는
  `pg`가 무시하므로 접속에 영향이 없다.
- 풀 공통: `connectionTimeoutMillis: 10_000`, `keepAlive: true`, `keepAliveInitialDelayMillis: 30_000`.
  pg-pool은 이 10초를 연결 시도와 **풀이 가득 차 빈 슬롯을 기다리는 시간** 모두에 쓴다(분리 불가). 그래서 DB가
  멈추면 크론은 무한 대기 대신 10초 뒤 실패한다. 주문 전이면 주문 없이 끝나고, 체결 후 기록 단계에서 나면
  기존 DB 오류와 같은 경로(알림 → reconcile)를 탄다. 쿼리 실행 시간 자체는 묶지 않는다.
- `yarn db:migrate`는 실패하면 exit code 1로 끝난다.

### DB 스크립트 실행 경로 (`yarn db:migrate` · `db:seed-operator` · `db:seed` · `db:clear`)

운영 이미지에는 `drizzle/` 폴더도 마이그레이션 진입점도 없다 — **스크립트는 항상 로컬(이 레포 체크아웃)에서 돌린다.**

| 시점 | `DATABASE_URL` | 비고 |
|---|---|---|
| Neon(이관 전) | 기존 Neon URL (`postgresql://…neon.tech/…?sslmode=require&channel_binding=require`) | 공개 인터넷으로 직접 붙는다. 인증서가 공개 CA라 추가 설정 없음 |
| RDS(이관 후) | SSM 터널 URL (아래) | RDS는 private이라 터널 없이는 닿지 않는다 |

RDS 터널 절차:

1. siglens 레포에서 `yarn db:tunnel` — SSM 포트 포워딩으로 `localhost:6543` → RDS를 연다(터미널을 열어 둔다).
2. 이 레포에서 URL을 **셸 환경변수로** 주고 실행한다:

```bash
DATABASE_URL='postgres://trader_owner:<pw>@localhost:6543/trader?sslmode=no-verify' yarn db:migrate
```

- **`sslmode=no-verify`가 필요한 이유.** 터널 URL의 호스트는 `localhost`라 로컬로 분류되어 URL이 그대로 pg에
  넘어간다. pg 8.23은 `sslmode=require`를 `verify-full`로 처리하는데, RDS 인증서는 호스트명 `localhost`와
  맞지 않아 실패한다. `no-verify`는 암호화는 하되 인증서를 검증하지 않는다 — SSM 채널 자체가 인증·암호화되므로
  수용한다. `sslmode=disable`은 쓸 수 없다: RDS `rds.force_ssl`이 평문을 거부한다.
- **셸 변수가 `.env.local`보다 우선한다.** `db:*` 스크립트는 `tsx --env-file=.env.local …`로 도는데, Node의
  `--env-file`은 **이미 설정된 환경변수를 덮어쓰지 않는다**(Node 25.2 + tsx로 확인: `DATABASE_URL=sentinel
  tsx --env-file=.env.local …`에서 셸 값이 유지됨). 그래서 `.env.local`에 Neon URL이 남아 있어도 위처럼 앞에 붙인
  값이 이긴다. 반대로 변수를 안 붙이면 `.env.local`의 값(= 이관 전 Neon)으로 붙으니, 어느 DB를 치는지
  실행 전에 확인할 것. 단 `.env.local` 파일 자체는 있어야 한다(없으면 `node: .env.local: not found`로
  종료한다) — 비어 있어도 된다.
- 터널 URL의 비밀번호에 `@ : / ? # %`가 있으면 퍼센트 인코딩한다.

**RDS CA 번들 교체 절차** (AWS가 번들을 갱신할 때. 번들은 빌드 때 내려받지 않고 `certs/`에 커밋해 둔다)

```bash
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o certs/rds-global-bundle.pem
shasum -a 256 certs/rds-global-bundle.pem        # 새 해시를 PR 본문에 적는다
grep -c 'BEGIN CERTIFICATE' certs/rds-global-bundle.pem   # 인증서 개수 확인(현재 111)
```

파일만 교체하면 되고(`Dockerfile`은 경로만 참조) 이미지를 다시 빌드·배포한다. 현재 번들 SHA-256은
`fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c`. 교체 전 RDS의 CA(`rds-ca-rsa2048-g1` 등)가
새 번들에 들어 있는지 확인한다.

마이그레이터는 미적용 마이그레이션 전체를 **한 트랜잭션**으로 실행한다 — 중간에 실패하면 SQL과 적용 기록이
함께 롤백된다. 제약은 §12 "마이그레이션 트랜잭션 제약" 참고.

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

> **⚠️ 0018 (`analysis_results.timeframe`)은 더 심각하다 — 운영 모드와 무관하게, 코드가
> 마이그레이션보다 먼저 배포되면 `analysis_results`를 건드리는 모든 쿼리가 그 즉시 깨진다.**
> 분석 크론은 전 종목 `status:'error'`, execute 크론은 전 포지션 `action:'error'`로 떨어진다.
> per-symbol try/catch가 잡아 잘못된 주문은 안 나가지만, 보유 포지션의 손절·목표가 감시가
> 그 시간 동안 조용히 멈춘다. 배경과 SQLSTATE 근거는 §12 참고 — 여기서는 순서만 지킬 것.

`drizzle/` 디렉터리는 버전관리에 포함되어 있으며 `yarn db:migrate`는 FRESH DB에서도 정상 동작한다 (0004 마이그레이션에 `IF NOT EXISTS` 적용).

**방법 A — yarn db:migrate (권장, FRESH/기존 DB 모두 동작)**
```bash
# Neon(이관 전)은 기존 URL, RDS(이관 후)는 SSM 터널 URL — §1 "DB 스크립트 실행 경로"
DATABASE_URL='<§1의 URL>' yarn db:migrate
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
2. **스키마 마이그레이션** — 위 단계로 `client_order_id` 컬럼 존재 확인. **`timeframe`(0018)은 특히
   순서가 중요하다** — 코드보다 먼저 적용하지 않으면 배포 직후부터 리스크 감시가 조용히 멈춘다
   (위 경고 박스 및 §12 참고)
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
| execute | `2-59/5 13-21 * * 1-5` | 매매 판단/실행 (분산 락). 실제 실행 여부는 `execute_interval_min` 설정(기본 10분)이 정한다 — 간격에 안 걸린 틱은 `off_interval`로 조기 종료 |
| reconcile | `*/10 13-21 * * 1-5` | 미체결 주문 타임아웃 + DB 정합성 |

UTC 13~21시 = KST 22:00~06:59. 실제 실행은 런타임 게이트 `isEtRegularSessionOpen`이
미국 정규장으로 다시 좁힌다(장외 발화는 `market_closed`로 조기 종료).

- `CRON_SECRET`은 여전히 필요하다. 스케줄러가 각 잡을 `Authorization: Bearer <CRON_SECRET>`을 실은
  요청으로 호출하므로, 미설정 시 스케줄러가 경고를 남기고 **비활성**된다.
- `/api/cron/*` 엔드포인트도 살아 있어 수동 트리거가 가능하다(같은 시크릿으로 인증).
- 실행 이력: 대시보드 Cron Runs 탭, 또는 `aws logs tail /siglens-trader/app --follow`.
- cron 실패는 SNS 알람(siglens 운영 토픽 `siglens-alerts`)으로 통지된다 — 박스가 정상이어도 매매만 멈추는
  경로라 별도로 감시한다.

---

## 4. Cloudflare Tunnel + DNS

인스턴스는 인바운드 포트를 열지 않는다. `cloudflared`가 아웃바운드로 터널을 맺고
Cloudflare가 그 터널로 트래픽을 보낸다(오리진 인증서 불필요).

**Elastic IP는 필요하다 — 인바운드가 아니라 출구 IP 때문이다.** 토스 Open API는 WTS
**설정 > Open API > 허용 IP 관리**에 등록된 IP에서만 토큰을 발급한다. 그 밖의 IP는
`POST /oauth2/token`이 `403 access_denied`라 실거래 모드의 모든 주문·조회가 실패한다.
자동 할당 공인 IP는 stop/start·재프로비저닝마다 바뀌므로 `provision.sh`가 `Name=siglens-trader`
태그의 EIP를 붙인다(현재 `3.34.121.104`). EIP를 붙이면 자동 할당 IP는 반납되어 공인 IPv4는
1개 그대로다(요금 동일, $0.005/시간). 인스턴스를 없앨 때 EIP를 남겨 두면 같은 요금이 계속 나간다.

1. Cloudflare Dashboard → Zero Trust → Networks → Tunnels → **Create a tunnel**
   - 이름: `siglens-trader`
   - 발급된 **토큰**을 `.env.production`의 `TUNNEL_TOKEN`에 넣고 `infra/aws/params.sh`로 SSM에 저장
2. 같은 화면 → Public Hostnames → Add
   - Subdomain `auto-trade`, Domain `siglens.io`
   - Service: `HTTP` → `localhost:3000`
   - CNAME은 Cloudflare가 자동 생성한다(수동 DNS 레코드 추가 불필요)
3. Cloudflare Access 애플리케이션(`auto-trade.siglens.io`)은 앞단 인증으로 남겨둘 수 있지만 필수는 아니다 — 자체 로그인이 기본 인증이다(§5 참고).

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

### API 인증 체계

`api/_lib/auth.ts`의 `isAuthenticated()` 동작 (위에서부터 순서대로 평가):

| 상황 | 동작 |
|------|------|
| `DISABLE_AUTH=true` (비프로덕션 환경) | 모든 인증 우회 (로컬 개발 전용) |
| `DISABLE_AUTH=true` (프로덕션 환경) | **무시됨** — 프로덕션에서는 DISABLE_AUTH가 동작하지 않음 |
| `trader_session` 쿠키가 살아있는 세션을 가리킴 | 통과 (**기본 경로**) |
| `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` 설정 + 유효한 `Cf-Access-Jwt-Assertion` | 통과 (Access를 앞단에 두는 동안의 병행 경로) |
| 그 외 | 403 |

`cf-access-authenticated-user-email` **헤더만 믿는 fallback은 제거됐다**. Access를 끄면
오리진이 직접 접근 가능해지므로, 그 헤더를 신뢰하면 누구나 위조해서 로그인을 우회할 수 있다.

### 자체 로그인 (기본 인증)

회원가입 엔드포인트는 없다. 계정은 스크립트로 생성한다.

```bash
# 두 명령 모두 §1 "DB 스크립트 실행 경로"의 DATABASE_URL로 실행한다
# (Neon: 기존 URL / RDS: 터널 URL — 셸 변수가 .env.local보다 우선)

# 마이그레이션 먼저 (users / sessions 테이블 + user_id 컬럼 생성)
DATABASE_URL='<§1의 URL>' yarn db:migrate

# 운영자 계정 생성 + 기존 데이터 소유권 이관
DATABASE_URL='<§1의 URL>' OPERATOR_EMAIL=dev.y0ngha@gmail.com OPERATOR_PASSWORD='<password>' yarn db:seed-operator
```

`db:seed-operator`는 멱등하다. 이미 계정이 있으면 비밀번호를 재설정하고(= 로테이션)
기존 세션을 전부 무효화한다. 이어서 `watchlist`, `analysis_model_config`, `positions`,
`trades`, `pending_orders`, `config`, `order_tracking`, `notification_config`의
`user_id`가 비어있는 행을 그 계정으로 채우고, 컬럼 DEFAULT도 같은 uuid로 설정한다
(그래서 매매·크론 insert 경로는 코드 변경 없이 그대로 동작한다).

- 세션 쿠키: `trader_session` — HttpOnly, SameSite=Lax, 프로덕션에서만 Secure, 30일
- 비밀번호 해시: bcrypt cost 12 (siglens와 동일 — 나중에 계정 통합 시 해시 그대로 사용 가능)
- 로그인 실패 스로틀: 클라이언트당 15분에 10회 (인프로세스 카운터, 단일 인스턴스 전제)

### Cloudflare Access 해제 순서

자체 로그인 배포 후 Access를 끌 때는 반드시 이 순서로 한다.

1. 배포 완료 확인 후, Access가 켜져 있는 상태에서 `auto-trade.siglens.io`에 접속해
   로그인 폼이 뜨고 실제 로그인이 되는지 확인한다 (Access + 자체 로그인 이중 통과).
2. Cloudflare Dashboard → Zero Trust → Access → Applications → `SigLens Trader` 삭제
   (또는 정책을 Bypass로 변경).
3. 시크릿 창에서 다시 접속해 **로그인 폼이 그대로 뜨는지** 확인한다. 대시보드가 바로
   보이면 인증이 통째로 열린 것이므로 즉시 Access를 되돌린다.

되돌리기: Access Application을 다시 만들면 원래 상태로 복귀한다.

**JWT 검증 환경변수** (SSM `/siglens-trader/*` — `infra/aws/params.sh`로 주입). Access를
완전히 제거했다면 더 이상 필요 없다.

```
CF_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
CF_ACCESS_AUD=<Access Application Audience Tag>

# 선택: 쉼표로 구분된 허용 이메일 목록 (설정 시 이 목록에 없는 이메일은 거부)
CF_ACCESS_ALLOWED_EMAILS=dev.y0ngha@gmail.com
```

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
DATABASE_URL='<§1의 URL>' yarn db:seed   # §1 "DB 스크립트 실행 경로" 참고
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

**`dry_run` ↔ 실거래 전환은 열린 포지션이 0개일 때만 한다.** 포지션에는 어느 모드에서 열었는지가
남지 않아, 모의 포지션을 안은 채 실거래로 넘어가면 브로커에 없는 주식에 실제 매도가 나간다.
대시보드(`POST /api/config`)는 이 경우 409로 막지만 위 SQL은 가드를 거치지 않는다. 가드는 확인 후
쓰기라 그 사이에 크론이 포지션을 열 수 있다 — 전환하는 동안은 킬 스위치(`trading_enabled = false`)를
꺼 두고, 전환 뒤 다시 켠다.

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
| GET | `/api/health` | 헬스체크 (인증 불필요, `?deep=true`로 DB 정합성 포함, `?ready=true`로 스키마 준비 상태 확인 — `infra/aws/deploy.sh`가 폴링) |

### Cron API (CRON_SECRET 인증)

| Method | Path | 역할 |
|--------|------|------|
| GET | `/api/cron/technical` | 기술적 분석 실행 |
| GET | `/api/cron/news` | 뉴스 분석 실행 |
| GET | `/api/cron/options` | 옵션 분석 실행 |
| GET | `/api/cron/fundamental` | 펀더멘털 분석 실행 |
| GET | `/api/cron/execute` | 매매 판단 + 실행 (분산 락, 서킷 브레이커 포함). **수동 트리거는 `?force=1`을 붙일 것** — 그러지 않으면 `execute_interval_min` 간격에 걸리는 분에만 실행되고 나머지는 `{"skipped":true,"reason":"off_interval"}`로 끝난다 |
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

### ⚠️ 0018 (`analysis_results.timeframe`) — 코드보다 **먼저** 적용해야 한다

이 마이그레이션은 "적용을 잊으면 새 기능만 안 되는" 종류가 아니다. **코드를 먼저
배포하면 `analysis_results`의 모든 쿼리가 깨진다.**

Drizzle은 `SELECT *`를 쓰지 않는다 — `.select()`가 스키마 객체에서 컬럼 목록을
만들어 명시적으로 나열한다. 그래서 `schema.ts`에 `timeframe`이 추가된 이미지가
컬럼 없는 DB를 만나면, 신규 쿼리뿐 아니라 기존 `getLatestAnalysisResult`,
`getAllLatestAnalysisResults`, `saveAnalysisResult`까지 전부
`column "timeframe" does not exist`로 실패한다.

실제 결과: 분석 크론은 전 종목 `status:'error'`, execute 크론은 전 포지션
`action:'error'`로 떨어진다. 잘못된 주문이 나가지는 않지만 — 각 크론의
per-symbol / per-position try/catch가 잡는다 — **보유 포지션의 손절·목표가
평가가 그 시간 동안 통째로 멈춘다.** 리스크 감시가 눈을 감는다.

`infra/aws/deploy.sh`는 이미지 pull과 서비스 재시작만 한다 — 마이그레이션은 실행하지
않으므로, 수동으로 **배포 전에** 실행할 것:

```bash
# Neon(이관 전)은 기존 URL, RDS(이관 후)는 SSM 터널 URL — §1 "DB 스크립트 실행 경로"
DATABASE_URL='<§1의 URL>' yarn db:migrate
```

컬럼 자체는 `DEFAULT '1Hour' NOT NULL`이라 기존 행이 자동 백필되고, 최신 Postgres에서
non-volatile 기본값 추가는 메타데이터 변경이라 테이블 재작성·락 폭주가 없다.

**이 순서를 놓치면 어떻게 되는가.** `/api/health`는 `?ready=true`로 호출하면
`analysis_results.timeframe`을 실제로 조회해(`lib/db/schema-readiness.ts`) 컬럼이 있는지
확인하고, `infra/aws/deploy.sh`는 (bare `/api/health`가 아니라) 바로 이 엔드포인트를 배포
성공 판정에 쓴다. Postgres가 `42703`(undefined_column) 또는 `42P01`(undefined_table)을
내면 — 즉 이미지와 스키마가 실제로 어긋난 경우에만 — `503`으로 응답해 배포가 `unhealthy`로
실패한다. 그 외 에러(타임아웃 2초 포함, 일시적 DB 장애 등)는 판정하지 못한 것으로 보고
`ready:true`를 낸다 — 배포 폴링 도중의 순간적인 DB 장애로 정상 롤아웃을 실패시키지
않기 위해서다. 이 판정은 진단 도구이지 안전장치가 아니다 — 순서를 지키는 것이 여전히
1차 방어선이고, 이건 그 순서를 놓쳤을 때 "포트는 열렸지만 리스크 감시는 죽어 있다"는
상태로 배포가 조용히 성공 처리되는 것을 막는 2차 방어선이다.


### 마이그레이션 트랜잭션 제약 (node-postgres 마이그레이터)

`yarn db:migrate`는 **미적용 마이그레이션 전부를 한 트랜잭션**에 넣고, 적용 기록 행도 같은 트랜잭션에서 넣는다
(옛 neon-http 마이그레이터는 트랜잭션이 없었다). 실패하면 SQL과 기록이 함께 롤백되어 반쯤 적용된 상태가 남지 않는
대신, 새 마이그레이션을 쓸 때 다음을 지켜야 한다:

- **`CREATE INDEX CONCURRENTLY` 불가.** 트랜잭션 안에서는 실행할 수 없다. 인덱스를 무중단으로 만들어야 하면 마이그레이션
  파일에 넣지 말고 DB에 수동으로 적용한다(`schema.ts`의 인덱스 정의와는 맞춰 둔다).
- **새 enum 값은 같은 배치의 뒤 마이그레이션에서 쓸 수 없다.** `ALTER TYPE … ADD VALUE`로 추가한 값은 그 트랜잭션이
  커밋되기 전에는 사용할 수 없다. 값 추가와 사용은 서로 다른 배포(별도 `db:migrate` 실행)로 나눈다.
- **`ALTER TABLE`의 락이 배치 전체가 커밋될 때까지 유지된다.** 마이그레이션이 여러 개 쌓여 있으면 앞쪽이 잡은
  ACCESS EXCLUSIVE 락이 뒤쪽 SQL이 끝날 때까지 풀리지 않아 그 테이블의 읽기·쓰기가 그만큼 막힌다. 한 번에 많이 쌓지
  말고, 큰 테이블을 건드리는 마이그레이션은 단독 배포로 실행한다.

`order_tracking` 테이블이 추가되었으며, 이후 `client_order_id TEXT` 컬럼 및 `trades.realized_pnl` 컬럼이 추가되었다.

`drizzle/` 디렉터리는 버전관리에 포함되어 있으며, `yarn db:migrate`는 FRESH DB에서 0000~0006 전체 마이그레이션을 순서대로 적용한다. 배포 전 반드시 마이그레이션을 실행할 것 (자세한 절차는 **배포 전 필수 섹션** 참고):

```bash
# Neon(이관 전)은 기존 URL, RDS(이관 후)는 SSM 터널 URL — §1 "DB 스크립트 실행 경로"
DATABASE_URL='<§1의 URL>' yarn db:migrate
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
| Dashboard 403 | 세션 만료/없음, 또는 로컬에서 DISABLE_AUTH 미설정 | 다시 로그인 / .env.local에 DISABLE_AUTH=true (프로덕션에서는 무시됨) |
| 로그인 429 | 15분 내 실패 10회 초과 | Retry-After 만큼 대기하거나 앱 재시작(카운터는 인프로세스) |
| 로그인이 계속 401 | 계정 미생성 또는 비밀번호 불일치 | `yarn db:seed-operator`로 계정 생성/비밀번호 재설정 |
| Dashboard 403 (JWT) | CF_ACCESS_TEAM_DOMAIN/AUD 설정 후 JWT 검증 실패 | Cf-Access-Jwt-Assertion 헤더 존재 여부 확인, AUD Tag 오타 점검 |
| 분석 안 됨 | LLM API 키 미설정 | ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY 확인 |
| 빈 대시보드 | watchlist 비어있음 | 설정에서 종목 추가 |
| 이메일 안 옴 | RESEND_API_KEY 미설정 | Resend 대시보드 확인 |
| Access 거부 | Cloudflare policy 미적용 | Zero Trust 설정 재확인 |
| Config 400 | 허용되지 않은 key | ALLOWED_CONFIG_KEYS 확인 (api/config.ts) |
| Execute skipped (locked) | 이전 execute cron이 아직 실행 중 | Redis 락 TTL (15분) 만료 대기, 또는 수동 키 삭제 |
| Auto 주문 insert 오류 | `client_order_id` 컬럼 없음 | `ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS client_order_id text;` 실행 후 재배포 |
| 배포가 `unhealthy`로 실패 (`journalctl`에 에러 없음) | `/api/health?ready=true`가 503 — 마이그레이션 전에 이미지가 배포됨(§12) | §1 경로(Neon 기존 URL / RDS 터널 URL)로 `yarn db:migrate` 실행 후 `infra/aws/deploy.sh <같은 태그>` 재시도. `curl -s "localhost:3000/api/health?ready=true"`의 `error` 필드에 SQLSTATE가 찍힌다 |
| Reconcile 이메일 폭발 | 다수 주문 30분 타임아웃 | broker 연결 상태 확인, 수동 주문 상태 업데이트 |
| 일일 손실 한도 초과 | 당일 실현+미실현 손실 합산 초과 | `max_daily_loss_usd` 조정 또는 다음 거래일까지 대기 |
