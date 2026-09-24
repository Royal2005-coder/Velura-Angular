#!/bin/bash
# Merge Stripe sandbox settings into /opt/velura/.env without printing values.
set -euo pipefail
file=/opt/velura/.env
if [ ! -r "$file" ]; then
  echo "cannot read $file"
  exit 1
fi
tmp=$(mktemp)
grep -v -E '^(STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|STOREFRONT_ORIGIN)=' "$file" > "$tmp" || true
if [ -n "${STRIPE_SECRET_KEY:-}" ]; then
  printf 'STRIPE_SECRET_KEY=%s\n' "$STRIPE_SECRET_KEY" >> "$tmp"
fi
if [ -n "${STRIPE_WEBHOOK_SECRET:-}" ]; then
  printf 'STRIPE_WEBHOOK_SECRET=%s\n' "$STRIPE_WEBHOOK_SECRET" >> "$tmp"
fi
if [ -n "${STOREFRONT_ORIGIN:-}" ]; then
  printf 'STOREFRONT_ORIGIN=%s\n' "$STOREFRONT_ORIGIN" >> "$tmp"
fi
sudo tee "$file" < "$tmp" >/dev/null
rm -f "$tmp"
echo "stripe env synced"
