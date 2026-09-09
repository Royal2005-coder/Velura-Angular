# Cloudflare and Supabase production URLs

Origin VM: Azure `web_group`, Ubuntu 24.04, public IP **135.235.219.13**.
Registered domain: **velura.royalai.dev**.

## Cloudflare DNS (sync these records)

| Type | Name | Content | Proxy | Purpose |
|---|---|---|---|---|
| A | `velura.royalai.dev` | `135.235.219.13` | Proxied (orange) | Customer SPA + `/api` |
| A | `admin.royalai.dev` | `135.235.219.13` | Proxied | Admin SPA |

The admin host is **`admin.royalai.dev`** (sibling of `velura.royalai.dev`), not `admin.velura.royalai.dev`. nginx accepts both.

Optional later: `develop` / `admin-develop` for a staging host. Not required for the first production cut.

## Cloudflare SSL/TLS

1. SSL/TLS mode: **Full** (origin has a certificate; self-signed is enough for Full). Do **not** use Flexible: origin used to 301 HTTP→HTTPS and that looped as `ERR_TOO_MANY_REDIRECTS`.
2. Origin nginx now serves the SPA on **both** port 80 and 443 so Flexible still works if someone leaves it on.
3. Always Use HTTPS: On.
4. Minimum TLS: 1.2.

After DNS is orange-clouded, public URLs:

- https://velura.royalai.dev/
- https://velura.royalai.dev/api/health
- https://admin.royalai.dev/login

## Supabase Auth allowlist

Project: `https://gtyuajboeffmfskofoyh.supabase.co`

Authentication → URL configuration:

**Site URL**

```
https://velura.royalai.dev
```

**Redirect URLs** (add all of these)

```
http://localhost:4001/auth/callback
http://localhost:4002/**
https://velura.royalai.dev/**
https://admin.royalai.dev/**
https://admin.royalai.dev/auth/callback
https://admin.velura.royalai.dev/**
https://admin.velura.royalai.dev/auth/callback
```

## Google Cloud OAuth (if Google SSO is enabled)

Authorized JavaScript origins:

```
http://localhost:4001
http://localhost:4002
https://velura.royalai.dev
https://admin.royalai.dev
https://admin.velura.royalai.dev
```

Authorized redirect URIs must include the Supabase callback:

```
https://gtyuajboeffmfskofoyh.supabase.co/auth/v1/callback
```

## API CORS on the VM

`/opt/velura/.env` must contain:

```
CORS_ORIGIN=https://velura.royalai.dev,https://admin.royalai.dev,https://admin.velura.royalai.dev
```

Browsers call `/api` on the same host through nginx, so CORS is a fallback for the admin subdomain.
