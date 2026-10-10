#!/usr/bin/env bash
set -euo pipefail
# Run on the VM after rsync. Uses the same sudo rights as production deploy.
DEPLOY_USER="${1:-azureuser}"


# Staging credentials must be provisioned separately; production secrets are never copied.
test -f /opt/velura-staging/.env || {
  printf '%s\n' 'Provision isolated /opt/velura-staging/.env before staging deployment.' >&2
  exit 1
}
test "$(stat -c %a /opt/velura-staging/.env)" = 600 || {
  printf '%s\n' 'Staging environment file must have mode 600.' >&2
  exit 1
}
grep -q '^PORT=8788$' /opt/velura-staging/.env
grep -q '^AI_ENABLE=false$' /opt/velura-staging/.env
grep -q '^CHAT_REPORT_EMAIL=.' /opt/velura-staging/.env || {
  printf '%s\n' 'Configure an explicit approved staging CHAT_REPORT_EMAIL before chatbot deployment.' >&2
  exit 1
}

# Migration credentials are independent and owner-provisioned; this gate never applies SQL.
MIGRATION_ENV=/opt/velura-staging/migrations.env
test -f "$MIGRATION_ENV" && test "$(stat -c %a "$MIGRATION_ENV")" = 600 || {
  printf '%s\n' 'Provision mode-600 staging migrations.env with STAGING_SUPABASE_DB_URL and STAGING_SUPABASE_DB_CA_CERT.' >&2
  exit 1
}
node --env-file="$MIGRATION_ENV" /opt/velura/scripts/run-migrations.mjs --check --environment=staging --require-chatbot-schema

sudo mkdir -p /var/www/velura-staging/user /var/www/velura-staging/admin /opt/velura-staging/api
sudo chown -R "${DEPLOY_USER}:${DEPLOY_USER}" /var/www/velura-staging /opt/velura-staging

cd /opt/velura-staging/api
npm install --omit=dev

sudo sed -i 's/\r$//' /opt/velura/deploy/nginx/velura.conf \
  /opt/velura/deploy/systemd/velura-api-staging.service \
  /opt/velura/deploy/scripts/remote-staging.sh || true

sudo cp /opt/velura/deploy/nginx/velura.conf /etc/nginx/sites-available/velura
sudo cp /opt/velura/deploy/systemd/velura-api-staging.service /etc/systemd/system/velura-api-staging.service
sudo sed -i "s/User=www-data/User=${DEPLOY_USER}/; s/Group=www-data/Group=${DEPLOY_USER}/" \
  /etc/systemd/system/velura-api-staging.service

sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable velura-api-staging
sudo systemctl restart velura-api-staging
sudo systemctl reload nginx || sudo /usr/sbin/nginx -s reload || sudo kill -HUP "$(pgrep -o nginx)"
