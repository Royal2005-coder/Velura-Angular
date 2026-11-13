# Technical Plan: Google SSO Activation, Mobile Header Layering, and Header Search Persistence Fix

**Track**: `KAN-66` / `specs/003-google-sso-and-header-ux-fixes`  
**Phase**: Stage 3 (Architecture & Implementation Plan)  
**Guidelines Followed**: Angular 21 Standalone + Signals, JSDoc business intent, no `NgModule`, no `any`, atomic testable steps.

---

## 1. Architecture Overview

### 1.1 Auth Flow (Storefront & Admin ERP)
```
[User clicks 'Đăng nhập bằng Google']
        │
        ▼
[sign-in.page.ts / auth-login.page.ts]
  - Generates PKCE code_verifier & code_challenge (SHA-256)
  - Generates cryptographically secure OAuth 'state' (32 bytes base64url)
  - Stores in localStorage:
      'velura-user-oauth-pkce-code-verifier'
      'velura-user-oauth-state'
  - Redirects to /api/auth/google?redirect_to=...&code_challenge=...&state=...
        │
        ▼
[apps/api: GET /api/auth/google]
  - Validates redirect_to against corsOrigins & /auth/callback
  - Validates state format
  - Returns 302 to Supabase:
    ${config.supabaseUrl}/auth/v1/authorize?provider=google&code_challenge=...&redirect_to=...&state=...
        │
        ▼
[Supabase Cloud (unzffihtqdqgqbgnwokj) GoTrue]
  - Requires Google Provider ENABLED with valid Client ID & Client Secret
  - Redirects to accounts.google.com
        │
        ▼
[Google Consent & Callback]
  - Redirects to Supabase: https://unzffihtqdqgqbgnwokj.supabase.co/auth/v1/callback
  - Supabase redirects to: https://velura.royalai.dev/auth/callback?code=...&state=...
        │
        ▼
[auth-callback.page.ts]
  - Checks state === stored state (CSRF protection)
  - Calls POST /api/auth/pkce { auth_code, code_verifier, redirect_uri }
  - Calls POST /api/user/auth/social-login { token }
  - Sets session, refreshes wishlist, navigates to /
```

### 1.2 Mobile Navigation Drawer Architecture
```
[Viewport <= 1024px]
.site-header (position: sticky; top: 0; z-index: 1000; background: #ffffff;)
  │
  ├── .site-header__container-grid (height: 72px;)
  │     ├── .header-col--left (Logo)
  │     └── .header-col--right (Wishlist, Cart, User, Hamburger button)
  │
  └── .site-header__nav (position: absolute; top: 100%; left: 0; right: 0; width: 100%;)
        ├── background: #ffffff;
        ├── box-shadow: 0 12px 32px rgba(0,0,0,0.12);
        ├── border-bottom: 1px solid var(--line);
        ├── z-index: 1000;
        ├── max-height: calc(100vh - 72px);
        ├── overflow-y: auto;
        └── .nav-link items
```

### 1.3 Reactive Search State Synchronization
```
[User searches /products?q=xxx]
  ├── router navigates to /products?q=xxx
  └── site-header syncSearchToRoute updates searchQuery('xxx')

[User clicks 'Bộ sưu tập' (/collections)]
  ├── router navigates to /collections
  ├── router.events emits NavigationEnd('/collections')
  └── syncSearchToRoute('/collections'):
        ├── searchOpen.set(false)
        ├── navOpen.set(false)
        ├── searchQuery.set('')
        └── resets DOM input.value if out of sync
```

---

## 2. File-by-File Change Matrix

| File | Change | Business Justification |
|------|--------|-------------------------|
| `deploy/k8s/base/database/supabase-stack.yaml` | Add `https://admin-erp.royalai.dev/auth/callback` to `GOTRUE_URI_ALLOW_LIST` | Ensures disaster recovery in-cluster standby allows Admin ERP OAuth callbacks without redirect rejection |
| `apps/user-ng/src/styles-velura/layouts/_header.css` | Fix `@media (max-width: 1024px) .site-header__nav` positioning, solid background, shadow, z-index, and scroll containment | Prevents mobile drawer links from rendering transparently on top of hero banner |
| `apps/user-ng/src/app/layout/site-header/site-header.html` | Add `#headerSearchInput`, `(click)="closeNav()"` on nav links | Immediate drawer closure and DOM ref binding for search sync |
| `apps/user-ng/src/app/layout/site-header/site-header.ts` | Wire `navOpen.set(false)` into `syncSearchToRoute`, add `closeNav()`, ESC key listener, and sync input DOM | Completely clears search when switching tabs; automatically collapses mobile menu |
| `apps/user-ng/src/app/features/auth/sign-in.page.ts` | Add OAuth `state` generation, storage, and URL parameter | Implements CSRF protection for OAuth flow |
| `apps/user-ng/src/app/features/auth/auth-callback.page.ts` | Add OAuth `state` validation against stored state | Guards against login CSRF attacks |
| `apps/user-ng/src/app/layout/site-header/site-header.spec.ts` | Add unit tests for `syncSearchToRoute` (nav closing & query reset) | Verifies regression prevention per SDD standards |

---

## 3. Risk Assessment & Verification Checkpoints

1. **Risk**: User modifies search input while already on `/products?q=...`.
   - *Mitigation*: `syncSearchToRoute` checks `isResults = parsed.pathname === '/products'`. When on `/products`, it preserves `parsed.searchParams.get('q')`.
2. **Risk**: Mobile drawer clips when opened on short landscape screens.
   - *Mitigation*: `max-height: calc(100vh - 72px); overflow-y: auto; -webkit-overflow-scrolling: touch;` ensures full accessibility.
3. **Risk**: GoTrue provider 400 persists until manual credentials saved.
   - *Mitigation*: The codebase and manifests are made 100% compliant; user is given precise 4-step dashboard activation instructions.
