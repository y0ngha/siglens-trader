# siglens-trader

US 주식 자동매매 시스템. AI 분석 결과를 기반으로 매매 신호를 생성하고, 설정된 모드에 따라 자동으로 주문을 실행한다.

## 동작 원리

```
[FMP / Yahoo Finance]  →  가격·뉴스·옵션·펀더멘털 데이터 수집
         ↓
[siglens-core]         →  프롬프트 빌드 + 분석 요청 (submit/poll)
         ↓
[siglens-worker]       →  LLM 호출 (Claude, Gemini, GPT)
         ↓
[strategy 모듈]        →  분석 결과 점수화 → 매매 판단
         ↓
[Toss Securities API]  →  주문 실행 (auto 모드일 때만)
```

### 분석 축

| 분석 | 데이터 소스 | 판단 근거 |
|------|------------|-----------|
| 기술적 분석 | FMP (가격/바) | 추세, 리스크 레벨, 지지/저항, 보조지표 시그널 |
| 뉴스 분석 | FMP (뉴스) | 시장 센티먼트, 이벤트 영향도 |
| 옵션 분석 | Yahoo Finance | Put/Call 비율, OI 변화, IV 분석 |
| 펀더멘털 분석 | FMP (재무제표) | 밸류에이션, 성장성, 재무건전성 |
| 종합 분석 | 위 4축 통합 | AI가 4개 분석을 종합하여 최종 판단 |

분석 로직과 프롬프트 빌딩은 [`@y0ngha/siglens-core`](https://github.com/y0ngha/siglens-core)에서 관리한다.

## 매매 모드

| 모드 | 동작 |
|------|------|
| `dry_run` | 실제 주문 없음. 가상 거래만 DB에 기록. |
| `semi_auto` | 신호 발생 시 이메일 알림 → 대시보드에서 승인/거절 |
| `auto` | 즉시 주문 실행 |

모든 거래에는 AI의 판단 근거(reason)가 저장되어, 사용자가 매매 판단의 품질을 평가할 수 있다.

## 기술 스택

- **Frontend**: React 19 + Vite (PWA)
- **Backend**: Vercel Serverless Functions (Cron)
- **DB**: Neon PostgreSQL + Drizzle ORM
- **분석**: [@y0ngha/siglens-core](https://github.com/y0ngha/siglens-core) + siglens-worker (LLM proxy)
- **데이터**: FMP API, Yahoo Finance
- **인증**: Cloudflare Access (Zero Trust)
- **알림**: Resend (Email)

## 필요한 외부 서비스

| 서비스 | 용도 | 비고 |
|--------|------|------|
| FMP API | 가격, 뉴스, 펀더멘털 데이터 | [financialmodelingprep.com](https://financialmodelingprep.com) |
| Yahoo Finance | 옵션 체인 데이터 | yahoo-finance2 npm 패키지 |
| LLM Worker | AI 분석 실행 | siglens-worker (자체 호스팅, 비공개) |
| Upstash Redis | 분석 작업 큐 | siglens-core 내부에서 사용 |
| Neon DB | 상태/이력 저장 | PostgreSQL |
| Toss Securities | 주문 실행 | Open API (개인용) |
| Resend | 이메일 알림 | |
| Cloudflare | DNS + Access 인증 | |

## 실행

```bash
# 의존성 설치
yarn install

# 개발 서버 (대시보드)
yarn dev

# DB 마이그레이션
yarn db:migrate

# Mock 데이터 삽입
yarn db:seed

# 테스트
yarn test

# 빌드
yarn build
```

## 환경변수

`.env.example` 참고. 주요 항목:

```
DATABASE_URL=          # Neon PostgreSQL
UPSTASH_REDIS_REST_URL= # 분석 작업 큐
WORKER_URL=            # LLM worker 서버 URL
WORKER_SECRET=         # Worker 인증 시크릿
FMP_API_KEY=           # 시장 데이터
TOSS_APP_KEY=          # 토스증권 (API 오픈 시 설정)
TOSS_SECRET_KEY=
CRON_SECRET=           # Vercel Cron 인증
RESEND_API_KEY=        # 이메일 알림
```

## 라이선스

PolyForm Noncommercial 1.0.0
