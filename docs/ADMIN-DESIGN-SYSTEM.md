# Design System: Velura Admin ERP

Source of truth for `apps/admin-erp-ng`. Tokens live only in `apps/admin-erp-ng/src/styles.scss` `:root`; components consume `var(--erp-*)`. Layout follows the CoreUI / ngx-admin admin shell (fixed sidebar, sticky header, card + table workspaces) in the storefront's white / pink / brown palette.

## 1. Visual Theme & Atmosphere
A warm, quiet operations console: cocoa-brown navigation rail, blush-white canvas, white working surfaces, one maroon accent. Density "Daily App Balanced" (6/10): every screen is a list or a detail that an operator scans many times a day, so hierarchy comes from weight and spacing, not decoration. Variance low (symmetric grids, predictable placement of actions). Motion restrained (140 ms ease on hover/press, no looping effects).

## 2. Color Palette & Roles
- **Slate Canvas** (`#F8FAFC`) — app background, filter bands; **Soft Container** (`#F1F5F9`)
- **Pure Surface** (`#FFFFFF`) — cards, tables, drawers, sidebar, sticky header
- **Rose Tint** (`#FFF1F3` / `#FFE4E6`) — selected pills, subtle active highlights
- **Structural Lines** — `--erp-line` (`#E2E8F0`) 1px card borders; `--erp-line-subtle` (`#F1F5F9`) row separators; `--erp-line-strong` (`#CBD5E1`) neutral button borders
- **Control Border** (`#8492A6`, hover `#64748B`) — inputs/selects (`3.16:1` on `#FFFFFF`, `3.02:1` on `#F8FAFC`, WCAG 2.1 SC 1.4.11)
- **Authoritative Ink** (`#0F172A`) — headings, values, body; **Muted** (`#64748B`) labels; **Soft** (`#94A3B8`) captions
- **Luxury Rose** (`#BE185D`, hover `#9D174D`) — the single accent: primary buttons, active tabs, focus rings, active nav indicator
- **Status on tint**: success `#059669`/`#ECFDF5` (line `#A7F3D0`), warning `#D97706`/`#FFFBEB` (line `#FDE68A`), danger `#E11D48`/`#FFF1F2` (line `#FECDD3`), info `#2563EB`/`#EFF6FF` (line `#BFDBFE`)

## 3. Typography Rules
- **UI:** Be Vietnam Pro 400/500/600/700 (`--erp-font`, `--erp-display`) — drawn for Vietnamese diacritics; 14px base, 1.5 leading; tables 13.5–14px with tabular figures.
- **Numbers:** JetBrains Mono 500/600 (`--erp-font-mono`) for KPI values, counts, and codes operators compare.
- **Headings:** Be Vietnam Pro 600, tight tracking (−0.015em); page title 22–26px, section 15–18px.
- **Wordmark only:** Cormorant Garamond 600 (`--erp-brand`) for the "Velura ERP" logo. No serif anywhere else in the console.
- **Banned:** Inter, DM Sans, Playfair, generic system serif in UI.

## 4. Component Stylings
- **Buttons:** 38px (`32px` `--sm`), radius 8px, flat. Secondary = white with `--erp-line-strong` & dark ink; Primary = Luxury Rose fill; Danger = solid Rose 600 (confirm dialogs) or `--danger-outline` (card/row delete actions so primary & destructive buttons never clash). No glow.
- **Inputs:** label above, 40px, `--erp-control-border` (`>= 3.0:1`), rose focus ring, error text below.
- **Cards:** white, 1px `--erp-line`, radius 12px, diffused slate shadow. Used for grouping, not decoration.
- **KPI widgets:** compact (14px padding), 28px tinted icon chip, mono value 22px, one-line hint. One row on ≥1280px.
- **Tables:** white sticky header with bottom rule, uppercase 12px muted labels, subtle hover, numeric columns right-aligned.
- **Badges:** pill (`flex-shrink: 0`), status tint + semantic border + dot.
- **Modal / drawer:** radius 16px, warm backdrop (`z-index: 80` for workspace modals, `z-index: 120` for confirm dialogs).
- **Loading:** skeleton rows/values matching the final layout; no spinners in tables.
- **Empty states:** icon + one sentence saying what is missing and where the data comes from.

## 5. Layout Principles
Sidebar 260px (72px icon rail when collapsed, persisted in `localStorage['velura-erp-sidebar-collapsed']`), aligned 56px (`--erp-topbar-h`) brand & sticky header divider, content max-width 1480px with 24–26px gutters. Page = header (eyebrow, title, one-line purpose, actions right) → KPI row → one workspace card (tabs + filter band + table/cards + pagination). Below 920px the rail becomes an off-canvas drawer; all grids collapse; no horizontal page scroll (tables scroll inside their card).

## 6. Motion & Interaction
transform/opacity only, 100–140 ms ease; hover lift −1px on cards; `prefers-reduced-motion` removes transitions. Keyboard: visible focus everywhere, ⌘K search, `/` focuses the page's first filter, tablists with arrow keys, ↑/↓ between table rows, Enter opens a row, J/K previous/next record in a drawer, Escape closes only the top-most overlay.

**Operator actions** (shared in `shared/ui` + `core`, never re-implemented per page):
- One primary button per screen and per modal footer. Modal/drawer footers stay visible while the body scrolls.
- Filters: selects, checkboxes and dates apply on change; text search applies after a 450 ms pause or Enter. Every filter, tab, page and the open record (`focus`) live in the URL (`writeQueryParams`), so Back, refresh and shared links reopen the same view.
- Consequential writes ask through `AdminErpConfirmService`: the button names the verb ("Khoá tài khoản", never "Xác nhận"); destructive ones use danger tone; audit-relevant ones require a written reason.
- Every write disables its button while running (no double submit) and reports through `AdminErpToastService`; the record drawer stays open with refreshed data unless the workflow ends.
- Forms with unsaved edits pass `[dirty]` to their modal/drawer; closing asks "Bỏ thay đổi?". Cancelling a sub-modal never closes the parent drawer.
- Load errors render inside the table with a retry, never as a banner on top of "no results". A filtered-to-empty table offers "Xoá bộ lọc".
- Frequent next steps are row quick-actions (≤2 per row); bulk actions only where the API has a bulk endpoint.

## 7. Anti-Patterns (Banned)
No fabricated metrics or demo records in production screens — a panel without a data source shows an empty state. No emojis. No pure black. No neon or gradient text. No more than one accent. No serif UI text. No raw hex in components (use tokens). No "Super Admin" style placeholder copy where the real operator name is known.
