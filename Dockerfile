# PDI TQMS — single web service image (Render Docker runtime).
FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.22.0-bookworm-slim
ENV NODE_ENV=production
# PostgreSQL 17 client tools for the application-consistent backup (npm run backup:create:prod).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates postgresql-common \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY seed ./seed
COPY assets ./assets
# The evidence disk is mounted at STORAGE_ROOT (e.g. /app/data); the app never falls back to the image layer.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "dist/server/server/index.js"]
