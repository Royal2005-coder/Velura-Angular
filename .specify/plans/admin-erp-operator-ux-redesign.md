# Technical Plan: Admin ERP Operator UX & Interface Redesign (KAN-106)

Governing Standard: `AGENTS.md` (Standalone + Signals, no `any`, no HttpClient in page components).
Target Architecture: Angular 21 Standalone Components, Signal-based state, Reactive UI ergonomics.

---

## 1. Architectural Foundation & Shared Primitives

### 1.1 Overlay Stack (`src/app/core/overlay-stack.ts`)
- Manages an active stack of open modals, drawers, and confirm dialogs.
- Listens to document-level `Escape` key and pops the topmost layer.
- Ensures nested overlays (e.g., Confirm dialog opened on top of an Edit Drawer) close independently without triggering dismissal of the parent container.

### 1.2 Unified Confirmation Service (`src/app/core/admin-erp-confirm.service.ts` & `src/app/shared/ui/admin-confirm.ts`)
- Promise-based API: `confirm(options: ConfirmOptions): Promise<ConfirmResult>`.
- Supports destructive danger styling (`tone: 'danger'`), explicit verb labeling ("Khóa tài khoản", "Hủy đơn"), and required reason validation (`requireReason: true`).
- Single host mounted at `AdminErpShell`.

### 1.3 Toast Service (`src/app/shared/ui/admin-toast.ts`)
- Queue-based toast manager emitting auto-dismissing notifications (`success`, `error`, `info`).
- Non-blocking notifications replace transient inline error strings.
- Single host mounted at `AdminErpShell`.

### 1.4 Deep Linking (`src/app/core/admin-erp-deep-link.ts`)
- Bidirectional synchronization between Angular Router `queryParams` and component Signals (`page`, `pageSize`, `search`, `tab`, `focus`).
- Handles clearing `focus` upon closing drawers to prevent unwanted reopen on browser reload.

---

## 2. Module Implementations

### 2.1 Pricing & Products
- Integrate `PriceChangeFormComponent`:
  * Old vs New price display with markdown calculation.
  * Validation rules ensuring sale price <= base price.
  * Confirmation modal trigger when price reduction exceeds 30%.
  * Double-submit disable state on submit buttons.
  * Clean up orphaned signals in `AdminErpPricingPage` (`previewBase`, `previewSale`, `previewPct`, `actionError`, `closeOverlays`).

### 2.2 Accounts & Members
- Fix compilation issues in `AdminErpAccountsPage`:
  * Provide `pageSize` signal access correctly.
  * Wire `openAction` method properly.
  * Implement required reason prompt for role changes.
  * Loyalty points adjustment preview showing previous balance -> new balance before write.

### 2.3 Orders & Returns
- Order cancellation modal: Change generic "Xác nhận" to "Hủy đơn hàng" with danger tone.
- Harmonize row click across all status tabs.
- Chat desk: Correct filter reset functionality and implement 10-second polling auto-refresh when tab is active.

### 2.4 Promotions & Reviews
- Campaign status change: Require reason when transitioning active campaign to paused.
- Concurrency protection: Send entity version during voucher toggle.
- Reviews moderation: Introduce "Duyệt & tiếp" (Approve & Next) workflow.
- Link reviews and logs to related order, member, and product drawers.

---

## 3. Testing Strategy
- Unit & contract tests in `apps/admin-erp-ng/src/app/shared/ui/admin-interaction.spec.ts`.
- Page specs verification:
  * `admin-erp-accounts.page.spec.ts`
  * `admin-erp-pricing.page.spec.ts`
  * `admin-erp-promotions.page.spec.ts`
  * `admin-erp-orders.page.spec.ts`
  * `admin-erp-logs.page.spec.ts`
- Build validation: `npm run build:admin-erp`.
