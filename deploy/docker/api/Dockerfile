FROM node:22.16.0-alpine3.22 AS builder
RUN apk upgrade --no-cache
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/user-ng/package.json ./apps/user-ng/
COPY apps/admin-ng/package.json ./apps/admin-ng/
COPY apps/admin-erp-ng/package.json ./apps/admin-erp-ng/
RUN npm ci
COPY apps/api ./apps/api
RUN npm run build:api

FROM node:22.16.0-alpine3.22 AS runner
RUN apk upgrade --no-cache
ARG RELEASE_REVISION
ARG RELEASE_BUILD_ID
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/user-ng/package.json ./apps/user-ng/
COPY apps/admin-ng/package.json ./apps/admin-ng/
COPY apps/admin-erp-ng/package.json ./apps/admin-erp-ng/
RUN npm ci --omit=dev --workspace @velura/api --include-workspace-root && npm cache clean --force \
    && rm -rf /root/.npm \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=builder --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=node:node /app/apps/api/src ./apps/api/src
RUN test "${#RELEASE_REVISION}" -eq 40 && \
    case "$RELEASE_REVISION" in *[!a-f0-9]*) exit 1;; esac && \
    case "$RELEASE_BUILD_ID" in *[!a-f0-9-]*) exit 1;; esac && \
    printf '%s\n' "$RELEASE_BUILD_ID" | grep -Eq "^${RELEASE_REVISION}-[0-9]+-[0-9]+$" && \
    printf '{"revision":"%s","buildId":"%s"}\n' "$RELEASE_REVISION" "$RELEASE_BUILD_ID" > /app/apps/api/dist/release.json
RUN mkdir -p /app/studio-assets && chown node:node /app/studio-assets
COPY --chown=node:node apps/ai-worker/assets/studio ./studio-assets
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
