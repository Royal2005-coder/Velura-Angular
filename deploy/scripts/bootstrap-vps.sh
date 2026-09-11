#!/usr/bin/env bash
set -euo pipefail

DEPLOY_USER="${SUDO_USER:-${USER}}"

sudo mkdir -p /var/www/velura/user /var/www/velura/admin /var/www/velura-staging/user /var/www/velura-staging/admin /opt/velura/api /opt/velura-staging/api /opt/velura/deploy /etc/nginx/ssl /var/www/html
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nginx rsync curl ca-certificates openssl

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi

if [ ! -f /etc/nginx/ssl/velura.key ]; then
  sudo openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout /etc/nginx/ssl/velura.key \
    -out /etc/nginx/ssl/velura.crt \
    -subj "/CN=velura.royalai.dev" \
    -addext "subjectAltName=DNS:velura.royalai.dev,DNS:admin.velura.royalai.dev"
fi

if [ -f /opt/velura/deploy/nginx/velura.conf ]; then
  sudo cp /opt/velura/deploy/nginx/velura.conf /etc/nginx/sites-available/velura
  sudo ln -sfn /etc/nginx/sites-available/velura /etc/nginx/sites-enabled/velura
  sudo rm -f /etc/nginx/sites-enabled/default
fi

if [ -f /opt/velura/deploy/systemd/velura-api.service ]; then
  sudo sed "s/User=www-data/User=${DEPLOY_USER}/; s/Group=www-data/Group=${DEPLOY_USER}/" \
    /opt/velura/deploy/systemd/velura-api.service | sudo tee /etc/systemd/system/velura-api.service >/dev/null
fi

sudo chown -R "${DEPLOY_USER}:${DEPLOY_USER}" /var/www/velura /var/www/velura-staging /opt/velura /opt/velura-staging
echo "${DEPLOY_USER} ALL=(root) NOPASSWD: /bin/systemctl restart velura-api, /bin/systemctl restart velura-api-staging, /bin/systemctl enable velura-api-staging, /bin/systemctl enable nginx, /bin/systemctl start nginx, /bin/systemctl restart nginx, /bin/systemctl daemon-reload, /bin/systemctl reload nginx, /usr/sbin/nginx, /bin/mkdir, /bin/chown, /bin/cp, /bin/sed, /usr/bin/tee" | sudo tee /etc/sudoers.d/velura-deploy >/dev/null
sudo chmod 440 /etc/sudoers.d/velura-deploy

sudo systemctl daemon-reload
sudo systemctl enable nginx
if [ -f /opt/velura/.env ]; then
  sudo systemctl enable velura-api
fi

sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx || sudo /usr/sbin/nginx
echo "Bootstrap complete for ${DEPLOY_USER}. Place /opt/velura/.env then start velura-api."
