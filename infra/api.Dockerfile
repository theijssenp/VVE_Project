# api.Dockerfile — multi-stage build voor de VvE-API (blok F02, spec §7.1/§7.9/§8.2).
#
# Base image vastgezet op een DIGEST (niet :latest / geen floating tag), spec §8.2:
#   "Bouw de productie-image met een lockfile en een vastgezette base image (digest,
#    geen :latest)." Zie docs/besluiten.md → F02 voor de exacte digest-waarden.
#
# Build-context is de repo-root (zie docker-compose.yml: context: ..), zodat alle
# workspaces beschikbaar zijn voor npm ci.
#
# --- Stage 1: builder — compileer TypeScript met alle (dev-)tools ---
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder

WORKDIR /repo

# Eerst de lockfiles + alle package.json's (cache-laag: wijzigen deze niet
# hoeft de lockfile niet opnieuw te downloaden).
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/app/package.json apps/app/package.json
COPY packages/domein/package.json packages/domein/package.json
COPY packages/contract/package.json packages/contract/package.json

# npm ci — NODIG: installeert exact de lockfile. Nooit npm install (spec §8.2).
RUN npm ci

# Kopieer daarna de bron en compileer (tsc -b bouwt alle workspaces; zie F01).
COPY tsconfig.base.json tsconfig.json ./
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY packages/domein/tsconfig.json packages/domein/tsconfig.json
COPY packages/contract/tsconfig.json packages/contract/tsconfig.json
COPY apps/api/src apps/api/src
COPY packages/domein/src packages/domein/src
COPY packages/contract/src packages/contract/src

# tsc -b produceert apps/api/dist, packages/domein/dist, packages/contract/dist.
RUN npm run build

# --- Stage 2: runtime — minimale image, non-root, géén devDependencies ---
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime

# Non-root: gebruik de in de node-alpine-image ingebouwde `node`-user (UID 1000) —
# de kleinste mogelijke runtime zonder een extra user-creatie-laag (spec §7.9:
# containers draaien niet als root).
USER node

WORKDIR /repo

ENV NODE_ENV=production \
    PORT=3000

# Alleen productiedependencies: npm ci --omit=dev levert een node_modules ZONDER
# devDependencies (eslint, vitest, typescript, ...). De workspace-symlinks
# (@vve/* → packages/*) worden door npm aangelegd.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/app/package.json apps/app/package.json
COPY packages/domein/package.json packages/domein/package.json
COPY packages/contract/package.json packages/contract/package.json
RUN npm ci --omit=dev

# Gecompileerde output uit de builder-stage (dist + tsconfig's die de runtime nodig heeft).
COPY --from=builder /repo/apps/api/dist apps/api/dist
COPY --from=builder /repo/packages/domein/dist packages/domein/dist
COPY --from=builder /repo/packages/contract/dist packages/contract/dist

# De .sql-migraties worden door tsc niet meegekopieerd (die kopieert alleen TypeScript-
# uitvoer). Zonder deze regel staan ze niet in de image en kan `db:migrate` in productie
# niet draaien: de runner zoekt ze naast zijn eigen gecompileerde bestand.
COPY --from=builder /repo/apps/api/src/database/migraties apps/api/dist/src/database/migraties
# Migreren in de container (vanuit /repo):
#   docker compose ... exec api node apps/api/dist/src/database/run-migraties.js

# Statisch geverifieerd door de container-healthcheck (GET /health, spec §7.9).
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>r.json().then(d=>{if(d.status!=='ok'){process.exit(1)}}).catch(()=>process.exit(1))).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/src/main.js"]
