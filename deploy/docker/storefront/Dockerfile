FROM node:22.16.0-alpine3.22 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/admin-ng/package.json ./apps/admin-ng/
COPY apps/user-ng/package.json ./apps/user-ng/
COPY apps/api/package.json ./apps/api/
RUN npm ci
COPY apps/user-ng ./apps/user-ng
RUN npm run build -w @velura/user-ng

FROM nginxinc/nginx-unprivileged:1.28.0-alpine
ARG RELEASE_REVISION
ARG RELEASE_BUILD_ID
COPY --from=builder /app/apps/user-ng/dist/user-ng/browser /usr/share/nginx/html
COPY deploy/docker/storefront/nginx.conf /etc/nginx/conf.d/default.conf
RUN test "${#RELEASE_REVISION}" -eq 40 && \
    case "$RELEASE_REVISION" in *[!a-f0-9]*) exit 1;; esac && \
    case "$RELEASE_BUILD_ID" in *[!a-f0-9-]*) exit 1;; esac && \
    printf '%s\n' "$RELEASE_BUILD_ID" | grep -Eq "^${RELEASE_REVISION}-[0-9]+-[0-9]+$" && \
    printf '{"revision":"%s","buildId":"%s"}\n' "$RELEASE_REVISION" "$RELEASE_BUILD_ID" > /usr/share/nginx/html/release.json
USER 101:101
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
