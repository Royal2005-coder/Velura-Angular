# Implementation Tasks: Google SSO & Header UX Fixes

**Branch**: `feature/KAN-66-supabase-cutover`  
**Spec**: [spec.md](./spec.md)  
**Plan**: [plan.md](./plan.md)  

---

## Phase 1: In-Cluster GoTrue & Disaster Recovery Configuration
- [x] **TASK-1.1**: Update `deploy/k8s/base/database/supabase-stack.yaml`
  - Added `https://admin-erp.royalai.dev/auth/callback` to `GOTRUE_URI_ALLOW_LIST`.
  - Verified with `git diff`.

---

## Phase 2: Mobile Navigation Drawer Styling
- [x] **TASK-2.1**: Update `apps/user-ng/src/styles-velura/layouts/_header.css`
  - Under `@media (max-width: 1024px)`, updated `.site-header__nav`:
    - `position: absolute; top: 100%; left: 0; right: 0; width: 100%;`
    - `background: #ffffff;`
    - `box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12);`
    - `border-bottom: 1px solid var(--line, #E8DFD6);`
    - `z-index: 1000;`
    - `max-height: calc(100vh - 72px);`
    - `overflow-y: auto;`
    - `-webkit-overflow-scrolling: touch;`
  - Verified solid background and clean layering.

---

## Phase 3: Header Template & Logic Hardening
- [x] **TASK-3.1**: Update `apps/user-ng/src/app/layout/site-header/site-header.html`
  - Added `#headerSearchInput` reference to the main header search `<input class="js-search-input">`.
  - Added `(click)="closeNav()"` to each navigation link in `.site-header__nav`.
- [x] **TASK-3.2**: Update `apps/user-ng/src/app/layout/site-header/site-header.ts`
  - Added `readonly headerSearchInput = viewChild<ElementRef<HTMLInputElement>>('headerSearchInput');`
  - Added `closeNav(): void { this.navOpen.set(false); }`
  - Updated `syncSearchToRoute(url)`:
    - Automatically sets `this.navOpen.set(false);`
    - Resets `this.searchQuery.set('')` when navigating away from `/products`.
    - Synchronizes DOM value of `headerSearchInput` and `overlayInput`.
  - Added `@HostListener('document:keydown.escape')` to dismiss navigation and search dropdowns.

---

## Phase 4: OAuth CSRF Protection
- [x] **TASK-4.1**: Update `apps/user-ng/src/app/features/auth/sign-in.page.ts`
  - Defined `STATE_STORAGE_KEY = 'velura-user-oauth-state';`
  - Generated random `state` in `startGoogle()`.
  - Saved to `localStorage` and included in redirect URL parameters.
- [x] **TASK-4.2**: Update `apps/user-ng/src/app/features/auth/auth-callback.page.ts`
  - Checked `state` parameter from query against `localStorage.getItem(STATE_STORAGE_KEY)`.
  - Fails with clear message if `state` is missing or mismatched.
  - Cleans up key upon completion.

---

## Phase 5: Testing & Verification Gate
- [x] **TASK-5.1**: Update `apps/user-ng/src/app/layout/site-header/site-header.spec.ts`
  - Added unit test: nav closes on `NavigationEnd`.
  - Added unit test: search query resets when route is outside `/products`.
  - Added unit test: Escape key listener closes drawer and search.
  - Added unit test: Native input DOM value syncs to empty string when route changes.
  - Test result: **12/12 tests passed**.
- [x] **TASK-5.2**: Run typecheck & build:
  - `npm run typecheck:api`: **Passed (0 errors)**.
  - `npm run build:user`: **Passed (Bundle generation complete)**.
- [x] **TASK-5.3**: Compiled clear step-by-step instructions for Supabase Cloud Dashboard Google Provider activation.

---

## Phase 6: OAuth Error Diagnostics & CSRF Hardening (EGM & Harness² Full-Cycle)
- [x] **TASK-6.1**: Fix State Bypass Vulnerability & Implement Multi-Tier OAuth Error Parser in `user-ng`
  - Enforce strict `state` validation (`if (storedState && (!returnedState || returnedState !== storedState))`).
  - Upgrade `describeOAuthError` handling: map `redirect_uri_not_allowed`, `identity_already_exists`, `database_error`, `server_error`, `invalid_grant`, `access_denied`, etc.
  - Expose `technicalCode` and `errorHint` signals to UI with copy button and one-click Google retry.
  - Unit test `auth-callback.page.spec.ts`: **8/8 tests passed**.
- [x] **TASK-6.2**: Synchronize OAuth Error Diagnostics & CSRF Hardening across `admin-erp-ng` and `admin-ng`
  - Port multi-tier error parser, state validation, and diagnostic badges to `apps/admin-erp-ng/src/app/features/auth/auth-callback.page.ts` and `apps/admin-ng/src/app/features/login/admin-auth-callback.page.ts`.
- [x] **TASK-6.3**: Harden API `/api/auth/google` and `/api/auth/pkce` error reporting in `apps/api/src/server.ts`
  - Ensure clear JSON error payload and allow storefront origins in `validatedOAuthRedirect`.
  - Redirect directly to callback with `?error=invalid_request` instead of throwing raw JSON on GET browser navigations.
- [x] **TASK-6.4**: Unit Tests & Regression Verification
  - API typecheck: `npm run typecheck:api` -> **Passed (0 errors)**.
  - API tests: `npm run test:api` -> **863/863 passed**.
  - User app build: `npm run build:user` -> **Application bundle generation complete**.
