FROM node:22-alpine AS builder
WORKDIR /app

# Copy root workspace and package manifests
COPY package.json package-lock.json* ./
COPY apps/user-ng/package.json ./apps/user-ng/
COPY apps/admin-ng/package.json ./apps/admin-ng/
COPY apps/api/package.json ./apps/api/

# Install dependencies
RUN npm ci

# Copy Storefront source and build
COPY apps/user-ng ./apps/user-ng
RUN npm run build -w @velura/user-ng

# Production Nginx container
FROM nginx:alpine AS runner
COPY --from=builder /app/apps/user-ng/dist/user-ng/browser /usr/share/nginx/html
COPY deploy/docker/storefront/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
