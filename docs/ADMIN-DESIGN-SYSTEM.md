# Design System: Velura Admin ERP

Source of truth for `apps/admin-erp-ng`. Tokens live only in `apps/admin-erp-ng/src/styles.scss` `:root`; components consume `var(--erp-*)`. Layout follows the CoreUI / ngx-admin admin shell (fixed sidebar, sticky header, card + table workspaces) in the storefront's white / pink / brown palette.

## 1. Visual Theme & Atmosphere
A warm, quiet operations console: cocoa-brown navigation rail, blush-white canvas, white working surfaces, one maroon accent. Density "Daily App Balanced" (6/10): every screen is a list or a detail that an operator scans many times a day, so hierarchy comes from weight and spacing, not decoration. Variance low (symmetric grids, predictable placement of actions). Motion restrained (140 ms ease on hover/press, no looping effects).

## 2. Color Palette & Roles
- **Blush Canvas** (#FAF5F7) — app background, filter bands
- **Pure Surface** (#FFFFFF) — cards, tables, drawers, header
- **Petal Tint** (#FDF2F4) — hover rows, soft accent fills
- **Rose Line** (#F0DDE2) — 1px card borders and dividers; **Subtle Line** (#F7ECEF) row separators
- **Control Border** (#A97886) — inputs/selects (3.67:1, WCAG 1.4.11)
- **Cocoa Ink** (#2A1A1D) — headings and values; **Body** (#351D25); **Mauve Muted** (#7A5A62) labels; **Soft** (#806870) captions (≥4.6:1)
- **Velvet Maroon** (#7A283C, hover #631F30) — the single accent: primary buttons, links, active state
- **Rose Focus** (#C94F70) — focus ring and active indicator only, never text (4.34:1)
- **Cocoa Rail** (#3A2622) with text #EBDCD8 (10.65:1), muted #C9B3AD (7.12:1), active pill rgba(201,79,112,.22)
- Status on tint: success #42624D/#F1F5E8, warning #8A5523/#FBF0E4, danger #B4233E/#FCE9ED, info #6F4A62/#F5EEF3 (all ≥5.4:1)

## 3. Typography Rules
- **UI:** Be Vietnam Pro 400/500/600/700 — drawn for Vietnamese diacritics; 14px base, 1.5 leading; tables 13.5px with tabular figures.
- **Numbers:** JetBrains Mono 500/600 for KPI values and codes operators compare.
- **Headings:** Be Vietnam Pro 600, tight tracking (−0.015em); page title 22–26px, section 15–18px.
- **Wordmark only:** Cormorant Garamond 600 for the "Velura" logo. No serif anywhere else in the console.
- **Banned:** Inter, DM Sans, Playfair, generic system serif in UI.

## 4. Component Stylings
- **Buttons:** 38px, radius 10px, flat. Primary = maroon fill; ghost = white with rose line; danger = red fill. No glow.
- **Inputs:** label above, 40px, Control Border, rose focus ring, error text below.
- **Cards:** white, 1px Rose Line, radius 14px, shadow tinted maroon at 5%. Used for grouping, not decoration.
- **KPI widgets:** compact (14px padding), 28px tinted icon chip, mono value 22px, one-line hint. One row on ≥1280px.
- **Tables:** white sticky header with bottom rule, uppercase 12px muted labels, petal hover, numeric columns right-aligned.
- **Badges:** pill, status tint + dot.
- **Modal / drawer:** radius 20px, warm backdrop rgba(42,20,28,.45).
- **Loading:** skeleton rows/values matching the final layout; no spinners in tables.
- **Empty states:** icon + one sentence saying what is missing and where the data comes from.

## 5. Layout Principles
Sidebar 250px (76px icon rail when collapsed, persisted in `localStorage['velura-erp-sidebar-collapsed']`), header 60px, content max-width 1480px with 24–26px gutters. Page = header (eyebrow, title, one-line purpose, actions right) → KPI row → one workspace card (tabs + filter band + table + pagination). Below 920px the rail becomes an off-canvas drawer; all grids collapse; no horizontal page scroll (tables scroll inside their card).

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
