FROM node:22.16.0-alpine3.22 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/admin-ng/package.json ./apps/admin-ng/
COPY apps/user-ng/package.json ./apps/user-ng/
COPY apps/api/package.json ./apps/api/
RUN npm ci
COPY apps/admin-ng ./apps/admin-ng
RUN npm run build -w @velura/admin-ng

FROM nginxinc/nginx-unprivileged:1.28.0-alpine
COPY --from=builder /app/apps/admin-ng/dist/admin-ng/browser /usr/share/nginx/html
COPY deploy/docker/admin/nginx.conf /etc/nginx/conf.d/default.conf
USER 101:101
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
