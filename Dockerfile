# syntax=docker/dockerfile:1

# ---- builder ----
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare yarn@4.12.0 --activate
WORKDIR /app
COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn ./.yarn
# @y0ngha/siglens-core lives on GitHub Packages (.yarnrc.yml npmScopes). The token is
# mounted as a BuildKit secret so it never lands in a layer or the build log.
RUN --mount=type=secret,id=SIGLENS_GITHUB_TOKEN,required=true \
    SIGLENS_GITHUB_TOKEN="$(cat /run/secrets/SIGLENS_GITHUB_TOKEN)" \
    yarn install --immutable
COPY . .
# Frontend only — a static Vite SPA, so no build-time DB/API credentials are needed
# (unlike siglens, which prerenders DB/FMP-backed routes at build time). The token is
# still mounted because .yarnrc.yml interpolates it on every yarn invocation.
#
# APP_VERSION은 **빌더에도** 필요하다. 런너에만 두면 서버는 태그를 아는데 번들은 모르는
# 상태가 되고, 그러면 화면의 번들 버전이 늘 `-dev`라 캐시 판별이라는 목적 자체가 죽는다.
ARG APP_VERSION=unknown
RUN --mount=type=secret,id=SIGLENS_GITHUB_TOKEN,required=true \
    SIGLENS_GITHUB_TOKEN="$(cat /run/secrets/SIGLENS_GITHUB_TOKEN)" \
    APP_VERSION="${APP_VERSION}" yarn build
# Drop devDependencies (typescript, vite, vitest, drizzle-kit, ...) now that the SPA is
# built — the runtime only needs the production tree, which roughly halves the image.
RUN --mount=type=secret,id=SIGLENS_GITHUB_TOKEN,required=true \
    SIGLENS_GITHUB_TOKEN="$(cat /run/secrets/SIGLENS_GITHUB_TOKEN)" \
    yarn workspaces focus --production

# ---- runner ----
FROM node:22-alpine AS runner
RUN apk add --no-cache tini
# AWS RDS 루트 CA 번들. RDS 서버 인증서는 공개 CA가 아니라 AWS 사설 CA가 서명하므로, Node 기본 신뢰
# 저장소만으로는 `lib/db/connection-config.ts`가 켜는 인증서 검증(verify-full)을 통과하지 못한다.
# `NODE_EXTRA_CA_CERTS`는 기본 저장소를 **대체하지 않고 추가**하므로 Neon(공개 CA)에도 영향이 없다.
# - 번들은 `certs/`에 커밋해 둔다(빌드 때 AWS에서 내려받지 않음): 빌드가 외부 URL 가용성·내용에 의존하지
#   않고, 번들 변경이 PR diff로 보인다. 교체 절차는 docs/DEPLOYMENT.md §1.
# - `--chmod=0644`: 이미 있는 `/etc/ssl/certs`(755)에 넣는 파일이라 `node` 사용자가 읽는다. 새 상위
#   디렉터리를 만들면 x 비트 없는 권한으로 생겨 읽지 못하니, 존재하는 디렉터리만 쓸 것.
COPY --chmod=0644 certs/rds-global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
WORKDIR /app
# 배포된 이미지 태그. `/api/health`가 이 값을 돌려주므로 "어떤 빌드가 도는지"를
# 배포 후 확인할 수 있다 — 종전 헬스 응답의 버전은 하드코딩된 '0.1.0'이었다.
ARG APP_VERSION=unknown
ENV NODE_ENV=production \
    PORT=3000 \
    APP_VERSION=${APP_VERSION} \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
# The server runs TypeScript directly via tsx (no server build step), so the runtime
# needs the sources it imports, not a compiled bundle.
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/server ./server
COPY --chown=node:node --from=builder /app/api ./api
COPY --chown=node:node --from=builder /app/lib ./lib
COPY --chown=node:node --from=builder /app/skills ./skills
COPY --chown=node:node --from=builder /app/package.json /app/tsconfig.json ./
# Fail the build (not the deploy) if the entrypoint's module graph can't load — a missing
# COPY or an unresolvable import would otherwise surface as a container crash-loop.
# The checks are shape-based on purpose: an earlier version asserted an exact job count,
# which broke the build the moment a legitimate job was added. What actually needs proving
# here is that the table loaded and is wired, not how long it is.
RUN node --import tsx -e "import('./server/app.ts').then(m => { const jobs = m.CRON_JOBS; if (!Array.isArray(jobs) || jobs.length === 0) { throw new Error('CRON_JOBS missing or empty'); } if (new Set(jobs.map(j => j.name)).size !== jobs.length) { throw new Error('duplicate cron job name'); } for (const j of jobs) { if (typeof j.handler !== 'function' || !j.schedule) { throw new Error('cron job not wired: ' + j.name); } } console.log('server graph ok — ' + jobs.length + ' cron jobs'); })"
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "server/index.ts"]
