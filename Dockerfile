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
RUN --mount=type=secret,id=SIGLENS_GITHUB_TOKEN,required=true \
    SIGLENS_GITHUB_TOKEN="$(cat /run/secrets/SIGLENS_GITHUB_TOKEN)" \
    yarn build
# Drop devDependencies (typescript, vite, vitest, drizzle-kit, ...) now that the SPA is
# built — the runtime only needs the production tree, which roughly halves the image.
RUN --mount=type=secret,id=SIGLENS_GITHUB_TOKEN,required=true \
    SIGLENS_GITHUB_TOKEN="$(cat /run/secrets/SIGLENS_GITHUB_TOKEN)" \
    yarn workspaces focus --production

# ---- runner ----
FROM node:22-alpine AS runner
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
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
RUN node --import tsx -e "import('./server/app.ts').then(m => { if (m.CRON_JOBS.length !== 6) { throw new Error('cron jobs: ' + m.CRON_JOBS.length); } console.log('server graph ok'); })"
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "server/index.ts"]
