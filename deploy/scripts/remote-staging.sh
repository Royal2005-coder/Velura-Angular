#!/usr/bin/env bash
set -euo pipefail
# Run on the VM after rsync. Uses the same sudo rights as production deploy.
DEPLOY_USER="${1:-azureuser}"

sudo mkdir -p /var/www/velura-staging/user /var/www/velura-staging/admin /opt/velura-staging/api
sudo chown -R "${DEPLOY_USER}:${DEPLOY_USER}" /var/www/velura-staging /opt/velura-staging

if [ -f /opt/velura/.env ] && [ ! -f /opt/velura-staging/.env ]; then
  sudo cp /opt/velura/.env /opt/velura-staging/.env
  sudo chown "${DEPLOY_USER}:${DEPLOY_USER}" /opt/velura-staging/.env
fi

if [ -f /opt/velura-staging/.env ]; then
  if grep -q '^PORT=' /opt/velura-staging/.env; then
    sudo sed -i 's/^PORT=.*/PORT=8788/' /opt/velura-staging/.env
  else
    echo 'PORT=8788' | sudo tee -a /opt/velura-staging/.env >/dev/null
  fi
fi

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
