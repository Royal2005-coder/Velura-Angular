# Feature Specification: Google SSO Provider Activation, Mobile Menu Layering, and Header Search Persistence Fix

**Feature ID**: `FEAT-AUTH-SSO-AND-HEADER-UX`  
**Ticket/Jira**: `KAN-66` (Supabase Auth Provider & Storefront Header UX Hardening)  
**Status**: Resolved after EGM Swarm Review (Stage 2)  
**Target Systems**:
- Supabase Cloud (`unzffihtqdqgqbgnwokj`) Auth Configuration
- In-Cluster GoTrue (`deploy/k8s/base/database/supabase-stack.yaml`)
- User Storefront (`apps/user-ng`) - `site-header.ts`, `site-header.html`, `_header.css`, `sign-in.page.ts`, `auth-callback.page.ts`
- Admin ERP (`apps/admin-erp-ng`) - `auth-login.page.ts`

---

## 1. Executive Summary & Root Cause Analysis

### 1.1 Problem 1: Google SSO `{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider is not enabled"}`
- **Observed Behavior**: When clicking "Đăng nhập bằng Google" on `https://velura.royalai.dev/auth/signin` or `https://admin-erp.royalai.dev/login`, the user is redirected to `/api/auth/google`, which redirects to `https://unzffihtqdqgqbgnwokj.supabase.co/auth/v1/authorize?provider=google`. Supabase GoTrue immediately returns `HTTP 400` with `{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider is not enabled"}`.
- **Root Cause & Solution**:
  1. In Google Cloud Console, Authorized Redirect URI `https://unzffihtqdqgqbgnwokj.supabase.co/auth/v1/callback` is saved.
  2. In Supabase Cloud Dashboard `Authentication -> URL Configuration`, `Site URL` and `Redirect URLs` (including `https://velura.royalai.dev/**` and `https://admin-erp.royalai.dev/**`) are saved.
  3. **Critical Gap**: In Supabase Cloud Dashboard under `Authentication -> Providers -> Google`, the toggle **"Enable Sign in with Google"** is currently **OFF** (Disabled), and the OAuth Client ID & Client Secret from Google Cloud Console have not been saved into Supabase.
  4. For the in-cluster disaster recovery GoTrue fallback (`deploy/k8s/base/database/supabase-stack.yaml`), `GOTRUE_URI_ALLOW_LIST` was missing `https://admin-erp.royalai.dev/auth/callback`.
  5. Security resolution from EGM Critic: Storefront Google OAuth flow will generate and verify a cryptographically random `state` parameter saved in localStorage to prevent login CSRF, in addition to existing PKCE verification.

### 1.2 Problem 2: Mobile Menu / Drawer Overlapping Hero Content
- **Observed Behavior**: On mobile screens ($\le 1024$px), clicking the hamburger toggle opens `.site-header__nav.is-open`. The menu items render transparently directly on top of the hero section text (`Bộ sưu tập Velura`), resulting in unreadable text collision.
- **Root Cause & Solution**:
  1. In `_header.css` under `@media (max-width: 1024px)`, `.site-header__container-grid` has `height: 72px;`.
  2. `.site-header__nav` was kept in CSS grid flow without `position: absolute`, without background color (`background: transparent`), and without `z-index`.
  3. Solution: Style `.site-header__nav` on $\le 1024$px as an absolute dropdown drawer anchored to `.site-header` (`top: 100%; left: 0; right: 0; width: 100%`) with solid white background (`#ffffff`), bottom border (`1px solid var(--line, #E8DFD6)`), shadow (`box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12)`), `z-index: 1000`, and `max-height: calc(100vh - 72px); overflow-y: auto;` to handle small screens without clipping.
  4. Automatically close the drawer on `NavigationEnd`, on any nav link click, and on Escape key press.

### 1.3 Problem 3: Search Input Query Stuck After Navigating Away
- **Observed Behavior**: When a user searches for a query (e.g. `đầm dạ tiệc`) and then clicks on another tab/category/collection (e.g. `Bộ sưu tập`), the search input box still retains the string `đầm dạ tiệc` instead of clearing.
- **Root Cause & Solution**:
  1. On `main` branch, router event subscription was absent.
  2. On feature branch, `syncSearchToRoute` updated the Angular signal `searchQuery`, but browser input elements retain typed values unless both the signal and the native input DOM element (`#headerSearchInput` and `#overlaySearchInput`) are synchronized.
  3. Solution: Subscribe to `NavigationEnd` in `site-header.ts`. When navigating to any route other than `/products` with `q`, reset `searchQuery.set('')`, close `searchOpen.set(false)`, close `navOpen.set(false)`, and explicitly reset native input values if they differ.

---

## 2. User Stories & Acceptance Criteria

### User Story 1: Google SSO Login (Priority: P0)
- **Scenario 1.1**: User clicks "Đăng nhập bằng Google" on `https://velura.royalai.dev/auth/signin`.
  - Browser redirects to `/api/auth/google?redirect_to=...&code_challenge=...&state=...`.
  - Supabase forwards to Google OAuth consent screen (`accounts.google.com`), with HTTP 200/302, not 400.
- **Scenario 1.2**: User completes Google authentication.
  - Google redirects back to Supabase `https://unzffihtqdqgqbgnwokj.supabase.co/auth/v1/callback`.
  - Supabase redirects to `https://velura.royalai.dev/auth/callback?code=...&state=...`.
  - Storefront validates `state`, exchanges `code` via `/api/auth/pkce`, calls `/api/user/auth/social-login`, and navigates to `/` with session active.

### User Story 2: Clean Mobile Navigation Drawer (Priority: P1)
- **Scenario 2.1**: User taps hamburger menu on mobile screen ($\le 1024$px).
  - Drawer opens with solid white background (`#ffffff`), `box-shadow`, `z-index: 1000`. Content below is completely occluded, no overlapping text.
  - Long lists scroll within `max-height: calc(100vh - 72px)`.
- **Scenario 2.2**: User taps any link in the drawer.
  - Drawer closes immediately (`navOpen = false`).
- **Scenario 2.3**: User presses Escape key.
  - Drawer closes immediately.

### User Story 3: Search Input State Lifecycle (Priority: P1)
- **Scenario 3.1**: User searches `đầm dạ tiệc` (`/products?q=đầm+dạ+tiệc`).
  - Search input shows `đầm dạ tiệc`.
- **Scenario 3.2**: User clicks "Bộ sưu tập" (`/collections`).
  - `searchQuery` signal resets to `''`.
  - Header search input element value clears to `''`.
  - Suggestions dropdown closes.

---

## 3. Detailed Technical Specifications

### 3.1 Supabase Cloud Dashboard Configuration Requirements
- Project URL: `https://supabase.com/dashboard/project/unzffihtqdqgqbgnwokj/auth/providers`
- Provider: **Google**
  1. Toggle **Enable Sign in with Google** to **ON**.
  2. Input **Client ID** (from Google Cloud Console).
  3. Input **Client Secret** (from Google Cloud Console).
  4. Ensure Google Cloud Console Authorized redirect URI includes: `https://unzffihtqdqgqbgnwokj.supabase.co/auth/v1/callback`.
  5. Click **Save**.

### 3.2 In-Cluster GoTrue Hot Standby Manifest (`deploy/k8s/base/database/supabase-stack.yaml`)
- Update `GOTRUE_URI_ALLOW_LIST`:
  ```yaml
  - name: GOTRUE_URI_ALLOW_LIST
    value: "https://velura.royalai.dev/auth/callback,https://admin.royalai.dev/auth/callback,https://shop.royalai.dev/auth/callback,https://admin-erp.royalai.dev/auth/callback"
  ```

### 3.3 Mobile Header Styling (`apps/user-ng/src/styles-velura/layouts/_header.css`)
- In `@media (max-width: 1024px)`:
  ```css
  .site-header__nav {
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    width: 100%;
    background: #ffffff;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12);
    border-bottom: 1px solid var(--line, #E8DFD6);
    flex-direction: column;
    align-items: stretch;
    padding: 12px 24px 20px;
    gap: 0;
    z-index: 1000;
    max-height: calc(100vh - 72px);
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    pointer-events: auto;
  }

  .site-header__nav.is-open {
    display: flex;
  }
  ```

### 3.4 Header Search & Navigation Logic (`site-header.ts` & `site-header.html`)
- In `site-header.html`:
  - Add `#headerSearchInput` to `<input class="js-search-input">`.
  - Add `(click)="closeNav()"` to each `<a class="nav-link">`.
- In `site-header.ts`:
  - Add `readonly headerSearchInput = viewChild<ElementRef<HTMLInputElement>>('headerSearchInput');`
  - In `syncSearchToRoute(url)`:
    * `this.searchOpen.set(false);`
    * `this.navOpen.set(false);`
    * Sync `searchQuery` and native input elements.
  - Add `closeNav(): void { this.navOpen.set(false); }`
  - Add `@HostListener('document:keydown.escape')` to close both `searchOpen` and `navOpen`.

### 3.5 Storefront OAuth CSRF Protection (`sign-in.page.ts` & `auth-callback.page.ts`)
- In `sign-in.page.ts`:
  - Generate random `state` via `randomVerifier()`.
  - Save `state` into `localStorage.setItem('velura-user-oauth-state', state)`.
  - Append `&state=${encodeURIComponent(state)}` to `/api/auth/google`.
- In `auth-callback.page.ts`:
  - Validate `state` from URL against stored `velura-user-oauth-state`.
  - If mismatch, reject and clear localStorage.
