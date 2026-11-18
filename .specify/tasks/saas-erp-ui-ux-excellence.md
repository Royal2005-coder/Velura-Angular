# Tasks: Velura Admin ERP SaaS UI/UX Excellence (`KAN-118`)

- [x] **T1 — Full-System UI/UX Forensic Audit, Spec & Technical Plan**
  - Audit all 11 ERP modules, Shell, Auth, Shared UI primitives, SVG sprite, and `--erp-*` CSS token references; publish `.specify/{specs,plans,tasks}/saas-erp-ui-ux-excellence.md`.

- [x] **T2 — 54-Glyph Topic Icon System, Token Completeness & Auth Polish**
  - Expand `public/admin-assets/icons/admin-icons.svg` with cohesive `24x24` `1.75px`-stroke domain icons (`coins`, `ticket`, `layers`, `shield-user`, `award`, `activity`, `logout`, `inbox`, `copy`, `x-circle`, `ban`, `truck`, `wallet`, `gift`, `trending-up`, `trending-down`, `megaphone`, `eye-off`, `calendar`, `hash`, `mail`, `phone`, `sparkles`, `chevron-left`, `chevron-right`, `filter-x`, `file-spreadsheet`).
  - Update `admin-erp-navigation.ts` with 11 unique sidebar icons + deep command-palette quick-actions registry.
  - Complete all missing `--erp-*` aliases, `.erp-kpi-grid`, `.erp-panel-head`, and themed scrollbars in `styles.scss`.
  - Redesign `auth-frame.ts` brand split-panel for WCAG AA+ contrast & `100dvh`, and add password visibility toggle in `auth-login.page.ts` & `auth-change-password.page.ts`.

- [x] **T3 — Anti-Overflow SaaS Shared UI Primitives (`shared/ui/*`)**
  - Upgrade `admin-data-table.ts`: remove blanket `table-fixed` crushing, add `minWidth` / `maxWidth`, universal `[attr.title]`, header `icon`, 2-line `subtext`, `cellIcon`, `secondaryBadge` (alongside `value`), 1-click `copyValue` with `AdminErpToastService`, sticky right `.col-actions`, and `inbox` default empty icon.
  - Upgrade `admin-kpi-card.ts` (`[interactive]`, `[active]`, `(selected)` output, clamped mono numerals, `min-width: 0`, `[attr.title]`).
  - Upgrade `admin-empty-state.ts` (`inbox` default), `admin-filter-bar.ts` (`/` shortcut hint pill), `admin-drawer.ts` & `admin-pagination.ts` (crisp SVG chevrons), and `admin-toast.ts` (semantic SVG tone icons).

- [x] **T4 — Shell & Keyboard-Driven `⌘K` Command Palette (`admin-erp-shell`)**
  - Add collapsed-rail tooltips (`[attr.title]`) and `logout` icon in `admin-erp-shell.html`.
  - Add `ArrowDown` / `ArrowUp` / `Enter` keyboard navigation, deep sub-queue search results (RBAC-filtered), and keyboard-shortcut legend footer in `admin-erp-shell.{ts,html,scss}`.

- [x] **T5 — All 11 Feature Modules SaaS Harmonization (`features/*`)**
  - Upgrade `dashboard`, `orders`, `returns`, `products`, `pricing`, `promotions`, `reviews`, `content`, `accounts`, `members`, and `logs`: responsive KPI grids, domain-accurate KPI & column icons, 2-line rich cells, 1-click copy on codes/SKUs/contacts, wired `[rowActions]` + `[rowId]` + `[pageSizes]` + `[emptyActionLabel]` + `[navigable]` drawers + clickable KPI filters + cohesive Vietnamese panel headers + fix all undefined `--erp-*` SCSS usages.

- [x] **T6 — Unit Specs, Monorepo Build/Test Gate & Production CI/CD Rollout**
  - Update & add unit tests (`admin-erp-navigation.spec.ts`, `admin-data-table.spec.ts`, `admin-erp-shell.spec.ts`, feature specs), run full `build` & `test` across workspaces, merge PR → `develop` → `main` → signed digests → Flux CD rollout, and verify live `https://admin-erp.royalai.dev`.
