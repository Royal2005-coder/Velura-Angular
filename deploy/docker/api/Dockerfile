FROM node:22-alpine AS builder
WORKDIR /app

# Copy root workspace and package manifests
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
COPY apps/user-ng/package.json ./apps/user-ng/
COPY apps/admin-ng/package.json ./apps/admin-ng/

# Install dependencies
RUN npm ci

# Copy API source and build
COPY apps/api ./apps/api
RUN npm run build:api

# Runtime container
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
RUN npm ci --omit=dev

COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/src ./apps/api/src

EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
