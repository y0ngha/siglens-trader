# siglens-trader: Vercel → AWS 이관 설계

- 작성일: 2026-07-19
- 상태: 설계 승인 대기 → 단계별 구현
- 참조: siglens의 Vercel→AWS 이관(`../siglens/infra/aws/`, `../siglens/.github/workflows/deploy.yml`, `../siglens/docs/superpowers/specs/2026-06-24-vercel-to-aws-migration-design.md`)

---

## 0. 배경 / 동기

- **Vercel 계정 차단**: 현재 PR/배포에서 Vercel 체크가 "Account is blocked"로 실패한다. siglens는 이미 AWS로 이관 완료(2026-06-24/25)했고, siglens-trader만 Vercel에 남아 사실상 배포가 막힌 상태다.
- **siglens와 인프라 일관성**: siglens가 이관한 방식(EC2 + Docker + ECR + Cloudflare + SSM + `v*` 태그 배포)을 재사용해 운영 부담을 줄인다.
- **비용**: siglens-trader는 **단일 사용자(오너)** 전용 도구로, Cloudflare Access(Zero Trust) 뒤에 있고 대부분 유휴 상태이며 cron 구동이 주 워크로드다. HA/오토스케일이 불필요하므로 siglens보다 **가벼운 토폴로지**를 채택한다.

## 1. 현재 아키텍처 (Vercel)

| 구성 | 현재 |
|---|---|
| 프론트엔드 | Vite React SPA → `dist/` 정적. `vercel.json` rewrite로 SPA fallback. 전 페이지 `X-Robots-Tag: noindex`. |
| API | `api/**/*.ts` Vercel Serverless Functions 15개. 핸들러는 **Web 표준** `(req: Request) => Promise<Response>`. maxDuration 800s, `includeFiles: skills/**`. |
| Cron | `vercel.json` crons 6개 → `/api/cron/*` HTTP 엔드포인트(`CRON_SECRET` 인증). |
| 인증 | Cloudflare Access(Zero Trust). `Cf-Access-Jwt-Assertion` JWT를 JWKS로 검증(`api/_lib/auth.ts`, jose). Vercel 비의존. |
| DB | Neon PostgreSQL(`@neondatabase/serverless`, HTTP 드라이버) + Drizzle. |
| 캐시/락 | Upstash Redis(`@upstash/redis`, REST) — 분석 큐 + Toss OAuth 토큰/accountSeq 캐시 + 분산락(`lib/lock.ts`). |
| 알림 | Resend. |
| 매매 | Toss Open API. |
| 도메인 | `auto-trade.siglens.io` (Cloudflare 프록시 + Access). |

**이관 친화성**: 유일한 Vercel 특화 요소는 `vercel.json`(함수 래핑 + cron + SPA rewrite)뿐이다. 핸들러가 Web 표준이고 DB/Redis가 HTTP/REST 기반, 인증이 CF Access라 애플리케이션 코드는 거의 그대로 이식된다. `@vercel/functions`(waitUntil)는 의존성에만 있고 실사용 코드는 없다.

## 2. 목표 아키텍처 (AWS)

```
Client
  └─ Cloudflare (auto-trade.siglens.io, orange-cloud + Zero Trust Access)
       └─ Cloudflare Tunnel (cloudflared, 아웃바운드 터널 — 인바운드 포트 개방 0)
            └─ EC2 (t4g.small, arm64, AL2023 pinned AMI)   ※단일 인스턴스, ALB/ASG 없음
                 └─ Docker 컨테이너 (Hono 서버 :3000)
                      ├─ 정적 SPA(dist/) 서빙 + SPA fallback(index.html)
                      ├─ /api/*  → 기존 Web 표준 핸들러 15개 마운트
                      └─ node-cron 스케줄러 6개 (Redis SETNX 분산락으로 중복 방지)

배포:  v* 태그 push → GitHub Actions → arm64 이미지 빌드 → ECR push
       → SSM SendCommand로 인스턴스에 `docker pull + systemctl restart` → health 검증 → CF cache purge
시크릿: SSM Parameter Store `/siglens-trader/*` (SecureString) → env-file → docker run --env-file
로그:   CloudWatch Logs `/siglens-trader/app`
외부 SaaS 유지: Neon(DB), Upstash(Redis), Resend, Toss, siglens-worker(분석)
```

### 2.1 siglens 대비 차이 (의도적 단순화)

| 항목 | siglens | siglens-trader |
|---|---|---|
| 컴퓨트 | ALB + ASG(min1/max4, t4g.medium) | **단일 EC2**(t4g.small), ASG/ALB 없음 |
| 인그레스/TLS | ALB(ACM cert), CF IP-lock SG | **Cloudflare Tunnel**(인바운드 0, 오리진 인증서 불필요) |
| 배포 반영 | ASG instance refresh(무중단) | **SSM SendCommand pull+restart**(수 초 다운타임 허용) |
| SSR/ISR/S3 캐시 | Next.js standalone + S3 cacheHandler | 없음(정적 SPA + JSON API) |
| Cron | 없음 | **node-cron 6개**(인프로세스) |
| golden AMI | 사용 | 선택(초기엔 pinned AL2023 + user-data 설치로 충분) |

단일 사용자·유휴·CF Access 뒤라는 특성상 무중단/HA는 불필요하고, 배포 시 수 초 다운타임은 허용된다(cron은 US 정규장 게이트 + 시간 단위 + `reconcile`이 갭 복구).

## 3. 컴포넌트 매핑 (Vercel → AWS)

| Vercel | AWS/대체 | 비고 |
|---|---|---|
| Serverless Functions | Hono 서버가 `api/` 핸들러를 라우트로 마운트 | 핸들러 시그니처 `(Request)=>Response` 무변경 |
| `vercel.json` rewrites(SPA) | Hono static 미들웨어 + `/*` → `index.html` fallback | `/api/*` 제외 |
| `vercel.json` headers(noindex) | Hono 미들웨어로 `X-Robots-Tag: noindex, nofollow` 부착 | |
| `vercel.json` crons | node-cron 6개(UTC 스케줄, `isEtRegularSessionOpen` 런타임 게이트) | 스케줄 문자열 그대로 |
| Vercel 환경변수 | SSM `/siglens-trader/*` → env-file | |
| Vercel 빌드 | Docker 멀티스테이지(arm64) | `tsc -b && vite build`(프론트) + 서버 tsc 빌드 |
| Vercel 배포 | `deploy.yml`(v* 태그) → ECR → SSM 배포 | |
| Vercel Cron 인증 | `CRON_SECRET`(node-cron은 로컬 호출이라 시크릿 검증 유지하되 내부 호출) | |
| CF Access | 변경 없음(오리진 무관) | |

## 4. 애플리케이션 서버 설계 (Phase 1)

### 4.1 서버
- `hono` + `@hono/node-server`.
- **정적**: `serveStatic({ root: 'dist' })` + SPA fallback(`/*` non-`/api` → `dist/index.html`).
- **API 마운트**: `api/`의 15개 핸들러를 명시적 라우트 테이블로 등록(동적 라우트 `approve/[id]`, `positions/[id]/close` 포함). 각 라우트: `app.all(path, (c) => handler(c.req.raw))`. 메서드 가드는 핸들러 내부가 이미 수행.
- **noindex 미들웨어**: 전 응답에 `X-Robots-Tag` 헤더.
- **health**: `/api/health` 기존 핸들러 재사용(cloudflared/모니터링 liveness).

### 4.2 node-cron
- 6개 스케줄(UTC)을 `node-cron`으로 등록. 각 tick은 해당 cron 핸들러 로직을 호출(내부적으로 `CRON_SECRET`을 실은 합성 `Request`로 기존 핸들러 재사용 → `verifyCronSecret` + 전체 로직 그대로).
- 중복 실행은 기존 `lib/lock.ts`(Redis SETNX)로 방지 → 인스턴스가 향후 늘어나도 안전.
- 스케줄(현행 유지):
  - `0 13-21 * * 1-5` technical / news / options
  - `0 15 * * 1-5` fundamental
  - `7 13-21 * * 1-5` execute
  - `*/10 13-21 * * 1-5` reconcile
- 타임존: UTC(`{ timezone: 'Etc/UTC' }`)로 Vercel(UTC)과 동일.

### 4.3 Graceful shutdown
- `SIGTERM`/`SIGINT` → node-cron stop + 서버 close + (진행 중 요청 짧게 drain) → exit. trader는 submit→poll이 cron 핸들러 내부에서 동기 완료되므로 별도 background-task 레지스트리 불필요.

### 4.4 서버 실행 (빌드 스텝 없음)
- 서버(api/lib)는 NodeNext ESM TS. 별도 트랜스파일 없이 **런타임 `tsx server/index.ts`**로 실행(trader는 이미 `tsx`로 db 스크립트 구동 중 → devDep을 dep로 승격). 장수명 서버라 시작 시 1회 트랜스파일 비용은 무시 가능하고, `dist-server/`·`tsconfig.server.json` 없이 끝난다.
- 타입 안전은 CI `yarn typecheck`(`tsc --noEmit`)가 이미 커버.

### 4.5 로컬 개발
- 기존 `yarn dev`(Vite + MSW)는 유지. 추가로 `yarn start`(빌드된 서버 로컬 실행) 스크립트 제공 → 컨테이너와 동일 경로 검증.

### 4.6 테스트
- 서버 라우팅(정적/SPA fallback/각 api 라우트 디스패치/noindex 헤더).
- node-cron 등록/핸들러 호출/스케줄 문자열 검증(가짜 타이머).

## 5. 컨테이너 (Phase 2)

- 멀티스테이지 `Dockerfile`(node:22-alpine, arm64):
  - **builder**: corepack yarn 4.x, `yarn install --immutable`(GitHub Packages 인증 = `SIGLENS_GITHUB_TOKEN` BuildKit 시크릿 — trader `.yarnrc.yml`도 `npm.pkg.github.com` 사용), `yarn build`(프론트 정적만). **빌드타임 DB/FMP 시크릿 불필요**(trader는 SSR/prerender 없음 — siglens와 달리 순수 정적 SPA).
  - **runner**: `dist/`(프론트), `server/`·`api/`·`lib/`(tsx로 실행), 프로덕션 `node_modules`, `skills/`(구 `includeFiles`) 복사. `tini` ENTRYPOINT, `CMD tsx server/index.ts`. `NODE_ENV=production PORT=3000`.
- `.dockerignore`(node_modules/.git/dist/coverage/test/e2e/docs/.env* 등).
- ECR 레포 `siglens-trader`(scan-on-push, lifecycle 최근 3개).

## 6. 인프라 (Phase 3) — `infra/aws/`

siglens 스크립트를 **대폭 축소** 이식(ALB/ASG/S3-ISR/golden AMI/13개 스크립트 → 4개). 단일 EC2엔 번호별 세분화가 과하다.

| 스크립트 | 목적 |
|---|---|
| `provision-iam.sh` | 1회: OIDC provider + ci-deploy 롤(ECR push + SSM SendCommand), EC2 인스턴스 롤(SSM param read + KMS decrypt + ECR pull + CW Logs). |
| `provision.sh` | 1회: ECR 레포(lifecycle 최근 3) + SG(**인바운드 없음** — Cloudflare Tunnel) + 단일 EC2(t4g.small arm64, pinned AL2023) + 인스턴스 프로파일 + user-data + CW Logs 그룹 + 핵심 알람(인스턴스 down / cron 실패 로그필터 / disk / mem → SNS). |
| `params.sh <env-file>` | SSM `/siglens-trader/*` SecureString 로더. |
| `deploy.sh <tag>` | SSM SendCommand(`docker pull <tag> && systemctl restart siglens-trader`) → health 폴링. |
| `user-data.sh` | (EC2 부팅) docker/CW agent/cloudflared 설치, SSM env fetch(jq→env-file), `docker pull` + systemd 유닛(app + cloudflared). |

*pon ceiling*: env 완전성 게이트(`check-env.sh`)는 초기엔 생략 — 키 누락은 배포 후 health/로그로 즉시 드러남. 잦은 키 변경으로 문제되면 그때 추가.

### 6.1 Cloudflare Tunnel
- `cloudflared`를 인스턴스에서 systemd/컨테이너로 상시 구동 → 아웃바운드 터널.
- CF 대시보드(Zero Trust → Networks → Tunnels)에서 터널 생성, `auto-trade.siglens.io` → `http://localhost:3000` public hostname 매핑. 터널 토큰은 SSM에 저장 → user-data가 주입.
- 기존 CF Access 애플리케이션(`auto-trade.siglens.io`)은 그대로 앞단 인증.
- 인바운드 포트 개방/오리진 인증서/EIP 전부 불필요.

## 7. CI/CD (Phase 4) — `.github/workflows/deploy.yml`

- 트리거: `push: tags ['v*']`(현 `release-it` 태깅과 연동).
- `test-gate`(typecheck + unit) → `deploy`(arm64 러너):
  1. OIDC로 AWS 자격 취득(`AWS_DEPLOY_ROLE_ARN`).
  2. ECR 로그인 → `docker buildx --platform linux/arm64` 빌드(시크릿: `SIGLENS_GITHUB_TOKEN`만 — 정적 SPA라 빌드타임 DB/FMP 불요) → `siglens-trader:<version>` push(‘:latest’ 없음).
  3. arm64 smoke(`node -e`).
  4. `deploy.sh <version>` → SSM SendCommand 배포 → health 검증.
  5. Cloudflare cache purge(`continue-on-error`).
- GH 시크릿: `AWS_DEPLOY_ROLE_ARN`, `AWS_ACCOUNT_ID`, `SIGLENS_GITHUB_TOKEN`, `CF_API_TOKEN`, `CF_ZONE_ID`. 변수: `PINNED_AMI`.

## 8. 환경 변수 / 시크릿

런타임(SSM `/siglens-trader/*`): `DATABASE_URL`, `CRON_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `WORKER_URL`, `WORKER_SECRET`, `FMP_API_KEY`, `MARKET_DATA_PROVIDER`, `RESEND_API_KEY`, `NOTIFICATION_EMAIL_FROM`, `TOSS_APP_KEY`, `TOSS_SECRET_KEY`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `CF_ACCESS_ALLOWED_EMAILS`, `TUNNEL_TOKEN`, (선택 BYOK) `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`. `NODE_ENV=production`.

`isProduction()`(`api/_lib/auth.ts`)는 `VERCEL_ENV` 없으면 `NODE_ENV`로 판정하므로 AWS에서 정상 동작(별도 수정 불요, 단 회귀 테스트로 확인).

## 9. 컷오버 & 롤백 (Phase 5)

1. SSM 파라미터 주입(`03-params.sh`), 인스턴스 기동, cloudflared 터널 연결.
2. 임시 검증 호스트 또는 Access 통과 후 `auto-trade.siglens.io`(터널)로 헬스/대시보드/1개 cron 수동 트리거 검증. **매매는 `trading_mode=dry_run`으로 검증 후 전환.**
3. CF DNS: `auto-trade.siglens.io`를 Vercel → Tunnel로 전환(터널은 CNAME 자동 관리). Vercel 배포는 롤백용으로 잠시 유지.
4. 안정화 후 Vercel 프로젝트 폐기, `vercel.json`/`@vercel/functions` 제거.
- **롤백**: CF DNS/터널 매핑을 Vercel로 되돌림(전환 초기), 또는 이전 ECR 태그로 `deploy.sh` 재실행.

## 10. 리스크 / 유의

- **실매매 안전**: 컷오버 검증은 반드시 `dry_run` 우선. `execute`/`reconcile` cron이 중복 주문을 내지 않도록 기존 idempotency key + Redis 락 유지 확인.
- **단일 인스턴스 = SPOF**: 인스턴스 down 시 cron 정지 → CloudWatch 알람(인스턴스 상태 + cron 실패 로그 필터)으로 감지. 매매 도구라 알람 필수.
- **cron 시각 정확도**: node-cron은 프로세스 로컬. 재시작/배포 창에 걸친 tick은 누락 가능 → 세션 게이트 + `reconcile`이 완화. 배포는 장외 시간 권장.
- **리전 = `ap-northeast-2`(Seoul) 확정**: siglens와 동일 계정/리전(운영 일관성), Toss(KR, 주문 레이턴시 중요) + siglens-worker(분석 호출)에 근접. 유일한 비용은 Neon/Upstash(현 us-east-2)로의 크로스리전 DB/Redis RTT(~180ms/call). cron은 800s 예산 + 세션당 소수 심볼이라 감내 가능. *pon ceiling*: cron 레이턴시가 실측상 문제되면 Neon을 ap 리전으로, Upstash를 global/ap로 이전(데이터 이관 필요) — 초기엔 하지 않음.

## 11. 단계별 구현 (PR 분할)

- **Phase 0**(본 문서): 설계 스펙. — *현재 PR*
- **Phase 1**: Hono 서버 + node-cron + tsx 실행 + 테스트. `@vercel/functions` 미사용 dep 제거.
- **Phase 2**: Dockerfile + `.dockerignore` + ECR.
- **Phase 3**: `infra/aws/` 스크립트 + Cloudflare Tunnel.
- **Phase 4**: `deploy.yml` + OIDC + 시크릿.
- **Phase 5**: 컷오버 + 문서(DEPLOYMENT.md 재작성, infra/aws/README.md) + Vercel 제거.

각 Phase는 워크트리에서 구현 → Opus 리뷰 → PR → 머지 후 다음 Phase.
