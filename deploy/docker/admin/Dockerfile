FROM node:22-alpine AS builder
WORKDIR /app

# Copy root workspace and package manifests
COPY package.json package-lock.json* ./
COPY apps/admin-ng/package.json ./apps/admin-ng/
COPY apps/user-ng/package.json ./apps/user-ng/
COPY apps/api/package.json ./apps/api/

# Install dependencies
RUN npm ci

# Copy Admin Portal source and build
COPY apps/admin-ng ./apps/admin-ng
RUN npm run build -w @velura/admin-ng

# Production Nginx container
FROM nginx:alpine AS runner
COPY --from=builder /app/apps/admin-ng/dist/admin-ng/browser /usr/share/nginx/html
COPY deploy/docker/admin/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
