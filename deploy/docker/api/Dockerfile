FROM node:22.16.0-alpine3.22 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/user-ng/package.json ./apps/user-ng/
COPY apps/admin-ng/package.json ./apps/admin-ng/
RUN npm ci
COPY apps/api ./apps/api
RUN npm run build:api

FROM node:22.16.0-alpine3.22 AS runner
ARG RELEASE_REVISION
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/user-ng/package.json ./apps/user-ng/
COPY apps/admin-ng/package.json ./apps/admin-ng/
RUN npm ci --omit=dev --workspace @velura/api --include-workspace-root && npm cache clean --force
COPY --from=builder --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=node:node /app/apps/api/src ./apps/api/src
RUN test "${#RELEASE_REVISION}" -eq 40 && \
    case "$RELEASE_REVISION" in *[!a-f0-9]*) exit 1;; esac && \
    printf '%s\n' "$RELEASE_REVISION" > /app/apps/api/dist/release-revision
RUN mkdir -p /app/scratch/ai-private && chown node:node /app/scratch/ai-private
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
