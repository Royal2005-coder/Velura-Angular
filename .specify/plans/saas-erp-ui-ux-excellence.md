# Technical Plan: Velura Admin ERP SaaS UI/UX Excellence (`KAN-118`)

## Architecture & Constraints
- **Isolated Docker Context (`apps/admin-erp-ng` only)**: All icons, tokens, helpers, and components stay strictly inside `apps/admin-erp-ng` (`deploy/docker/admin-erp/Dockerfile` copies only `apps/admin-erp-ng`).
- **Component Style Budget (`< 32kB`)**: Shared layout patterns (`.erp-kpi-grid`, `.erp-panel-head`, `.erp-copy-btn`, token aliases, themed scrollbars) live in `apps/admin-erp-ng/src/styles.scss`; `admin-erp-content.page.scss` (`21.4kB`) and `admin-erp-dashboard.page.scss` (`15.1kB`) stay well below `32kB`.
- **Zero Contract Drift**: Keep all HTTP calls inside `AdminErpApiService`, preserve RBAC (`session.can(...)`), `expectedVersion`, and existing `data-testid` / spec contracts (`admin-erp-shell.spec.ts`, `admin-erp-data-table.spec.ts`, `admin-erp-navigation.spec.ts`, and all 11 feature specs).

## Phased Execution
1. **T1**: Specification, audit artifact, and adversarial verification checklist.
2. **T2**: `admin-icons.svg` (54 semantic glyphs), `admin-erp-navigation.ts` (11 unique module icons + deep quick-links registry), `styles.scss` (complete `--erp-*` aliases, `.erp-kpi-grid`, `.erp-panel-head`, themed scrollbars), `auth-frame.ts` & `auth-login.page.ts` / `auth-change-password.page.ts`.
3. **T3**: Shared UI primitives (`admin-data-table.ts`, `admin-kpi-card.ts`, `admin-empty-state.ts`, `admin-filter-bar.ts`, `admin-drawer.ts`, `admin-pagination.ts`, `admin-toast.ts`).
4. **T4**: `admin-erp-shell.{ts,html,scss}` (collapsed tooltips, `logout` icon, keyboard-driven `⌘K` Command Palette with deep sub-queues & shortcut footer).
5. **T5**: All 11 feature modules (`dashboard`, `orders`, `returns`, `products`, `pricing`, `promotions`, `reviews`, `content`, `accounts`, `members`, `logs`) — anti-overflow KPI grids, topic icons, rich 2-line cells, copyable codes, sticky row actions, clickable KPI filters, `J`/`K` drawer navigation, and Vietnamese panel headers.
6. **T6**: Unit test expansion + full monorepo build/test verification + PR → `develop` → `main` signed container digests → Flux CD live verification.
