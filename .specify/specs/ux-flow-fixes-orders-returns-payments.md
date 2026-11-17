# Spec: Orders / Returns / Payments / Forms — 13 requirements (KAN-110)

Source: owner UAT report 2026-11-17 (screenshots #1-#13). Evidence = scout reports plus live production env/log checks via `kubectl --context velura-k3s -n velura` (2026-11-17): PAYMENT_GATEWAY_SIMULATOR=on, ENVIRONMENT=sandbox, no VNPAY_*/MOMO_* env, only STRIPE_SECRET_KEY set.
Guardrails (AGENTS.md): Standalone+Signals, no `any`, no HttpClient in pages, no fake data replacing real API, JSDoc on public symbols, money/OTP/RBAC/state machine rules unchanged, contract changes via migration + API + UI in same PR.

## R1 Stripe partial refund hangs / 0đ / status not updated (admin returns)
- Cause (hypothesis, code): `stripe.ts refundStripeOrder` `fetch` has no timeout; soft `requested` outcomes look like success; payment only becomes refunded in `velura_complete_return_refund` when Stripe says `succeeded`; `cs_` ref (no `pi_`) fails.
- Fix: AbortSignal timeout (15s) on Stripe calls -> typed error `GATEWAY_REFUND_TIMEOUT`; UI `saving` always cleared (finalize); when result is `requested` UI says "Đang chờ cổng xác nhận" (not success) and the line shows `REFUND_PENDING` with refreshed refundable amount; resolve `pi_` from Checkout Session (`cs_`) before refund. Timeout semantics: a refund is reported as `requested` only when the POST outcome is unknown (timeout/network after send); a definite gateway rejection is `failed`.
- AC: modal never spins forever; failure shows Vietnamese reason; refunded amount / item status refreshed after response.

## R2 COD manual refund `PT422 COD_PAYMENT_REQUIRED`
- Cause: migration 107 defined `velura_record_return_manual_refund` (wrong word order); live fn is `velura_record_manual_return_refund` (113) with no missing-payment-row handling.
- Fix: new migration 128 recreates the REAL function name: COD order with no payment row / non-stripe provider => synthesize COD payment row marked `paid` (only when the order is `delivered`/`completed`, amount only from `orders.total_amount`, item already RECEIVED), record refund, no `COD_PAYMENT_REQUIRED`. Both functions lock `orders` first so concurrent returns on one legacy COD order create a single row (no unique index added: existing production duplicates unknown). Drop the unused 107 function. Prepare RPC accepts COD payment `pending` on a delivered/completed order -> promote to `paid` (`gateway_response_code='COD_MANUAL_REFUND_BACKFILL'`); other states keep `CAPTURED_PAYMENT_REQUIRED`. Production DB lacks `return_item.pickup_scheduled_at` until 128 is applied.
- AC: COD return refund with bank transfer proof succeeds; `PT422` gone.

## R3 Order detail false "Vui lòng xác thực chủ đơn trước khi xem chi tiết."
- Cause: `order-flow.page.ts open()` swallows any error/stale-context result into `openUnauthorized()`; race with store effect `refresh()` (`current(context)` false returns silently).
- Fix: wait for store initial load; retry `ensureOrderLoaded` once with fresh context; show real error message; show the "xác thực" message only for 401/403 (and only guests).
- AC: member deep-link / refresh of `/account/orders/:id` opens the detail reliably.

## R4 Avatar dropdown needs multiple clicks, never closes
- Fix: `accountOpen` signal in `site-header.ts`; avatar is a `<button>` toggling; click-only (hover behaviour removed): `.is-open` replaces `:hover/:focus-within`; closes on outside click, item click, route change, Escape. Remove hover gap.

## R5 "Tra cứu đơn hàng" shown to logged-in members
- Fix: remove the member-menu `/account/track` item (`site-header.html`), keep guest entry.

## R6 Ship flow (admin orders)
- "Xác nhận đơn": no QR scan; submit through plain note modal (`confirm_cod`).
- "Chuẩn bị hàng" (`start_processing`): on success generate a simulated carrier waybill + label QR (API `carrier-gateway-simulator`, route `POST /api/v1/admin/orders/:id/carrier-label`), show label in the modal with "In nhãn" (order info, time, address, QR, tracking).
- "Xác nhận vận đơn" (`upsert_shipment`, renamed): opens scanner immediately; QR scan fills carrier/tracking (no manual typing), mandatory proof photo, then chained `confirm_handover` (existing). Shipper handover = scan label QR + photo.
- EXC (exchange) orders (born `confirmed`) get the same prepare label QR.
- State machine / money untouched. No new order status (reuse `shipping`).

## R7 Returns flow (admin returns)
- Approve: no QR scan (drop `'approve'` from `needsQrScan`); keep call-confirm hint and proof rules.
- On approve: store pickup slot (next day 09:00) and show to admin + member + email/notification; unify QR payload `velura:return:1?id=&code=` in email and web. (migration 128: `return_item.pickup_scheduled_at`; existing WAITING_RETURN rows keep a null slot and the UI handles null.)
- Pickup: shipper scans return label QR, no typed `pickedUpBy`, photo required; carrier fields from QR.
- Warehouse `receive`: QA by dropdown criteria + note instead of 5 checkboxes (still maps to the 5 booleans the RPC needs).
- Fix modal layout overlap (`.record__grid` MÃ VẬN ĐƠN over TRẠNG THÁI; `.flow-check` / qr-confirm overflow).

## R8 Exchange any product incl. free-size / same variant (storefront)
- `replacementChoices` stops filtering the original variant; label "Cùng mẫu (đổi sản phẩm lỗi)"; stock rule kept; DB/API already allow.

## R9 VNPay / MoMo sandbox "Đơn đã lưu nhưng chưa mở được cổng thanh toán"
- Status: PARTIAL / OPEN on production credentials. Verified live: production runs `ENV=sandbox` with `PAYMENT_GATEWAY_SIMULATOR=on`, no `VNPAY_*` / `MOMO_*` variables, and only `STRIPE_SECRET_KEY` set, so VNPay/MoMo cannot open a gateway session.
- Decision: NO simulator fallback in production code (unsafe: it would mark orders as gateway-paid without a real gateway). Code change is limited to diagnostics: `payment_error.code` exposed in the response + storefront message by code, structured log of the failure reason, and a `super_admin` readiness endpoint that reports which gateway credentials are configured.
- Remaining (ops, not code): configure real VNPAY and MOMO sandbox credentials in the production environment; until then R9 is not resolved.

## R10 Live validation on every form (web + admin)
- Validate on blur/change not only on submit; stale ward error cleared in `updateGeography()`/draft; `AddressSelector` gets `invalid`/`touched` + red state. Shared CSS `.is-required::after` red `*`, `.ng-invalid.ng-touched` red border; admin already has `.erp-required`.

## R11 Spinners instead of text loaders ("Đang tải đơn hàng và yêu cầu đổi trả…")
- One global `.spinner` class per app + visually-hidden label; replace text-only loaders in the order/returns pages (full ~30 sweep best-effort).

## R12 Red asterisks for required fields everywhere
- Storefront: label `*` rendered via red span class; admin: `.erp-required` used on all required labels.

## R13 Video preview overflow in return form (storefront) + admin raw file inputs
- `.preview-images video` sized; admin raw `<input type=file>` (return pickup, orders modal) use styled `.custom-file-row` pattern.

## Out of scope / Open
- Production verification of R1 (no cluster access). R9 stays PARTIAL/OPEN on production credentials (see R9). Loyalty-model reconciliation (separate ticket).
