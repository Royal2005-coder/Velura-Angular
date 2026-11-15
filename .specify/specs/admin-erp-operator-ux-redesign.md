# Spec: Admin ERP Operator UX & Interface Redesign (KAN-106)

Governing Standard: Velura `AGENTS.md` (Standalone + Signals, no `any`, no HttpClient in page components).
Reference Best Practices: `coreui-free-angular-admin-template`, `ngx-admin`, and Velura `docs/ADMIN-DESIGN-SYSTEM.md`.
Target Branch: `feature/KAN-106-admin-erp-operator-ux` -> `develop` -> promote `main`.

---

## 1. Executive Summary & Objective

The Velura Admin ERP (`apps/admin-erp-ng`) requires a comprehensive UX overhaul to eliminate operator friction, prevent costly operational errors, and align with enterprise admin template standards (CoreUI & ngx-admin). Operators currently face ambiguous button actions, double-submission risks on async mutations, modals that hide action buttons when scrolling, filters lost on page refresh, and lack of keyboard navigation.

This redesign implements a complete **Operator Ergonomics Contract** across all 12 ERP modules without altering backend contracts or introducing fake data.

---

## 2. Core Architectural & Ergonomic Requirements

### 2.1 Shared Layout & Shell Ergonomics
- **Single Primary Action Rule**: Exactly one primary button per screen view and modal/drawer footer. Secondary actions use ghost/outline styling.
- **Sticky Overlay Footers**: Modals and drawers must feature fixed sticky footers while body content scrolls independently.
- **Stack-Aware Overlays**: Escape key and backdrop clicks operate on a LIFO stack (`OverlayStack`). Dismissing a nested confirm dialog or sub-modal must never dismiss the parent drawer underneath.
- **Unsaved Changes Guard**: Any form with unsaved changes (`[dirty]`) must prompt for operator confirmation ("Bỏ thay đổi?") prior to discarding.
- **Global Keyboard Navigation**:
  - `/`: Immediately focus the page's primary filter/search field.
  - `⌘K` / `Ctrl+K`: Global command palette.
  - `J` / `K` or `‹` / `›`: Navigate to previous/next record while a drawer is open.
  - `↑` / `↓`: Move selection between table rows; `Enter`: Open details drawer for selected row.

### 2.2 Filter & URL Synchronization
- **Deep-Link State**: Every active filter, tab, pagination offset, and `focus` (currently inspected record ID) must synchronize bidirectional with URL query parameters via `AdminErpDeepLink`.
- **Immediate vs Debounced Application**:
  - Dropdown selects, checkboxes, and date pickers apply state updates immediately.
  - Text input searches apply with a 450ms debounce or immediately on pressing `Enter`.
  - Filter button ("Lọc") is demoted from primary to regular action.

### 2.3 Consequential Write Protection & Feedback
- **Specific Action Verbs & Danger Tone**: Destructive confirms must name the verb explicitly ("Hủy đơn hàng", "Khóa tài khoản", "Tạm dừng chiến dịch") and use danger styling (`--erp-danger`).
- **Required Reason Input**: Audit-critical actions (role assignment changes, campaign pauses, account locks) require a mandatory text explanation.
- **Price Guardrail**: Reductions exceeding 30% require a two-stage confirmation displaying before/after calculations.
- **Double-Submit Prevention**: All mutation buttons must disable immediately upon submission until the async operation resolves.
- **Non-Intrusive Feedback**: Centralized toast notifications (`AdminErpToastService`) replace ad-hoc inline text. Drawers remain open with refreshed data.

---

## 3. Module-by-Module Scope of Changes

| Module | Core Upgrades |
|---|---|
| **Orders & Returns** | Danger-styled cancel confirm with distinct verbs; unified row-click across tabs; chat desk filter reset & auto-refresh; carrier QR trigger wired. |
| **Products & Pricing** | Unified `PriceChangeFormComponent` showing old -> new with markdown %; double-submit lock; `focus` deep-linking. |
| **Promotions & Reviews** | Required reason to pause campaigns; versioned voucher toggling; "Duyệt & tiếp" rapid review moderation; direct links to order/member/product. |
| **Accounts & Members** | Required justification for role modifications; balance preview for manual loyalty points adjustment; account lock/unlock quick-actions. |
| **Content & Logs** | Separate success/error messages in blog editor; direct click-through links from audit logs to order/product/user drawers. |

---

## 4. Verification & Non-Functional Criteria
- **Build**: `npm run build:admin-erp` passes with zero TypeScript or Angular compiler errors.
- **Unit & Contract Tests**: `npm run test:admin-erp` passes all unit tests and interaction specs (`admin-interaction.spec.ts`).
- **Accessibility & Contrast**: Meets WCAG 2.1 AA (contrast >= 4.5:1) per `docs/ADMIN-DESIGN-SYSTEM.md`.
- **Responsive Ergonomics**: Fully responsive across desktop (1440x900) and compact tablet/mobile viewports (390x844).
