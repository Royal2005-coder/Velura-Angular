# Spec: Fulfillment & Exchange - explicit steps, no silent auto-advance (KAN-116)

Branch: `feature/KAN-116-ux-flow-cms`. Scope: Admin ERP (`apps/admin-erp-ng`) + API (`apps/api`) + 1 projection change (no migration). Guardrails (AGENTS.md): Standalone + Signals, no `any`, JSDoc on public symbols, router -> service -> repository in API, no fake data replacing the real API, state-machine / money / RBAC rules unchanged.

All file:line references below were read in the worktree at spec time. Line numbers drift; identify by symbol.

---

## 1. Problem (owner quotes, UAT)

> "fix lại cho thao tác quy trình cho mua hàng thì cho chuẩn bị đơn hàng hiển thị QR in và chuẩn bị dán là xong, quay lại màn hình xử lý đơn hàng để chuẩn bị xong rồi nào cần xác nhận người đó mới bấm nút bước tiếp theo là nút xác nhận, KHÔNG tự động chuyển qua luôn, vì dán QR xong cần chuẩn bị hàng 1 thời gian rồi mới bấm nút tôi xác nhận."

> "Đổi trả thì hoàn hàng: khi QA thành công hàng cần đổi hàng rồi thì chuyển tiếp mượt mà, tạo đơn hàng đổi trả sau cho đơn hàng là bước xác nhận xong và đơn hàng đổi trả sẵn sàng; rồi bên đơn hàng làm đúng tiếp theo chuẩn: đơn hàng mã đổi trả link trên hệ thống và cùng link với bên ĐVVC; generate/dán QR ở bước chuẩn bị hàng xong, và tới bước xác nhận là bấm nút tiếp theo (status mới) tiếp tục mở QR để xác nhận chuẩn chỉnh; flow hoàn chỉnh."

Operational reading (to remove ambiguity):

1. **Prepare step** ("Bắt đầu chuẩn bị hàng"): show waybill + QR, operator prints/sticks it, **closes the dialog and returns to the order screen**. Printing/showing a QR must never move the order anywhere and must not push the operator into the next step.
2. **Confirm step** (later, minutes/hours after sticking): operator presses an explicit button; **that** press opens the QR scanner; scan + parcel photo + submit = the only thing that moves the order to `shipping`.
3. **Exchange**: warehouse QA pass -> UI moves straight into creating the exchange order (one confirm click) -> then straight into that exchange order's prepare step in Orders (deep link). The exchange order carries the return code and the same carrier tracking/link as the return's outbound shipment. From there it follows rules 1 and 2 exactly like a sale order.

---

## 2. Current behavior (evidence)

### 2.1 Sale order: confirmed -> processing -> shipping (Admin ERP, `features/orders`)

State machine (`apps/api/src/orders/order-state-machine.ts` `ORDER_ACTIONS`, lines 87-110):

| code | from | to |
|---|---|---|
| `start_processing` ("Bắt đầu chuẩn bị hàng") | `confirmed` | `processing` |
| `upsert_shipment` ("Xác nhận vận đơn", `fields:["shipment"]`) | `processing` | `null` (status-neutral, migration 038) |
| `confirm_handover` ("Xác nhận bàn giao ĐVVC") | `processing` | `shipping`; guard `TRACKING_CODE_REQUIRED` / `SHIPMENT_VOIDED` (`actionGuard`) |

`allowedAdminActions` (same file, ~line 210) already hides `confirm_handover` until a tracking code exists (`actionGuard(...) === null` filter), so there is no QR-less path to `shipping`.

Flow in `apps/admin-erp-ng/src/app/features/orders/admin-erp-orders.page.ts` (`AdminErpOrdersPage`):

1. Row action "Chuẩn bị hàng" (`orderRowActions`, ~line 281) or drawer footer button -> `openAction(start_processing)` -> `submitAction` -> `runAction` (line 1162).
2. `runAction` success branch for `start_processing` (line ~1174-1177): toast + `this.openCarrierLabel(result.order)`. This opens `modal = {kind:'carrier_label'}` and `GET /api/v1/admin/orders/:id/carrier-label` (`createCarrierLabel`, `apps/api/src/orders/order-service.ts` ~line 357; `createWaybill` in `apps/api/src/carrier/carrier-gateway-simulator.ts`, deterministic from `order_code`, writes nothing). **This part is correct and stays** (label shown right after the explicit "Bắt đầu chuẩn bị" click).
3. Label modal markup (`admin-erp-orders.page.html`, `app-erp-modal` titled "Nhãn vận đơn", lines ~486-516): buttons `Đóng`, `In nhãn` (`printOrderLabel`, line 1315) and, when `hasAction(order,'upsert_shipment')`, a primary **`Xác nhận vận đơn`** button (line 510-511) bound to `continueToShipment()` (ts line 1304). Hint text (html ~503): "In nhãn, dán lên kiện hàng rồi quét lại ở bước “Xác nhận vận đơn”."
4. **Defect A - pushes the operator forward.** `continueToShipment()` closes the label modal and calls `openAction(upsert_shipment)`, and `openAction` line 900 does `if (action.code === 'upsert_shipment') this.scanOpen.set(true);` -> the QR scanner pops open immediately after the label. Print -> scan -> submit is one continuous funnel; there is no "go back, pack, come back later" moment.
5. **Defect B - one scan = save + handover.** `submitAction` (line ~1105-1130) for `upsert_shipment` requires `scanLocked()` + a parcel photo, uploads evidence, then `runAction`. `runAction` (doc lines 1158-1161, code line 1179) chains `handoverFollowUp(result.order, facts)` (`core/admin-erp-order-trace.ts:360`) -> `confirm_handover` automatically -> `shipping`. Mixed with Defect A, the operator can reach `shipping` from "Bắt đầu chuẩn bị" with no pause. (The chain itself is the *confirm* step's one explicit click and is kept, see D1.)
6. **Defect C - label cannot be reopened.** `canShowLabel` (ts line 220) is computed but referenced nowhere in `admin-erp-orders.page.html` (grep: only the definition). After the operator closes the label modal there is no button to print/show it again, which is why the current UI shoves the next step into the same dialog.
7. Footer (html ~300-312) lists `primaryActions()` (every non-destructive allowed action, one flat identical-style button each): while `processing` this shows `Ghi nhận thiếu hàng`, `Xác nhận vận đơn` (and later `Xác nhận bàn giao ĐVVC`) with no hierarchy telling the operator which is "the confirm".

### 2.2 Exchange order lifecycle

Return side (`apps/admin-erp-ng/src/app/features/returns`, `core/admin-erp-service-desk.ts`, DB `database/migrations/084_return_item_workflow.sql`):

- Item actions come from `returnItemActions` (`core/admin-erp-service-desk.ts:313`): `RETURN_SHIPPING -> receive`; for `resolution_type==='exchange'` with no `exchange_order_id` and `item_status==='RECEIVED'` -> `prepare_exchange`; `EXCHANGE_PREPARING -> ship_exchange`; `EXCHANGE_SHIPPING` + exchange order `delivered` -> `complete_exchange`.
- `receive` = warehouse QA modal (`return-flow.component.ts`, `needsQrScan` includes `receive`; line ~115). RPC `velura_return_item_action` (084, `when 'receive'` ~lines 348+) sets `item_status='RECEIVED'` only if `matches_product and tags_intact and condition_acceptable and package_match`, else `NEEDS_SUPPORT`. Returns `{return_id, item, lines}` (084 line 462: `jsonb_build_object('return_id',..,'item',to_jsonb(i),'lines',..)`).
- `prepare_exchange` (084 ~lines 424-436): requires stage `RECEIVED`, creates an `orders` row `status='confirmed'`, `order_kind='exchange'`, `order_code='EXC'||...`, `parent_order_id=original`, `source_return_id=p_return_id`, `source_return_item_id=i.return_item_id`, decrements variant stock, sets `i.exchange_order_id` and `item_status='EXCHANGE_PREPARING'`.
- `ship_exchange` in the Returns UI no longer calls the API: `AdminErpReturnsPage.openFlow` (`admin-erp-returns.page.ts` ~line 714) does `router.navigate(['/orders'], {queryParams:{focus: line.exchange_order_id}})` ("Shipping an exchange is the Orders module's job").
- Handover of the exchange order from Orders: trigger `trg_exchange_handover_syncs_return` -> `velura_sync_exchange_handover()` (migration `131_exchange_order_handover_syncs_return.sql`): when `orders.handed_over_at` flips from null to set on an `order_kind='exchange'` order with `tracking_code`, the linked `return_item` in `EXCHANGE_PREPARING` becomes `EXCHANGE_SHIPPING` and an outbound `return_shipment` row is inserted with the order's `carrier` + `tracking_code`. Trigger `return_shipment_outbound_tracking` (`089_return_outbound_tracking.sql`, `velura_ensure_outbound_tracking`) writes the (possibly regenerated `EXC...`) outbound code back to `orders.carrier/tracking_code`. So after handover the return line (`exchange_order.tracking_code/tracking_url` via `getExchangeOrder`, `apps/api/src/returns/return-repository.ts:224`) and the carrier-facing order share one tracking record.

Defects in the exchange chain:

- **Defect D - QA pass does not move on.** `ReturnFlowComponent.submit` -> `buildRequest` (`return-flow.component.ts` ~lines 536-583) calls `api.actOnReturnItem(...)` and **throws the response away** (`pipe(switchMap(() => of('')))`); `done` (`output<string>()`, line 61) emits `''`; `AdminErpReturnsPage.onFlowDone` (line 832) just closes the modal and reloads. The operator must then locate the part, open the menu and find `Chuẩn bị đơn đổi` themselves. No guidance that an exchange is now the next step.
- **Defect E - exchange order is not deep-linked after creation.** After `prepare_exchange` completes the same `onFlowDone` reload happens; the operator must press `Giao phần hàng đổi` (which then navigates to Orders). Two extra clicks and a mental hop.
- **Defect F - Orders auto-pops the label for a confirmed exchange order.** `openDetail` (ts line ~755) calls `maybeShowExchangeLabel(order)` (line 1295): for `order_kind==='exchange'` and status `confirmed|processing`, it opens the carrier label modal on drawer open (once per session via `exchangeLabelShown`, line 199), **without** the operator pressing "Bắt đầu chuẩn bị hàng". `canShowLabel` (line 220) and the API (`createCarrierLabel`: `exchangeReady = status==='confirmed' && order_kind==='exchange'`, message `CARRIER_LABEL_NOT_ALLOWED` in `order-repository.ts:286`) encode the same special case. In `confirmed` the `upsert_shipment` action is not allowed, so the modal's "Xác nhận vận đơn" button is hidden (`hasAction` false) and the modal is a dead end; the operator closes it, presses "Bắt đầu chuẩn bị hàng", and the label modal opens a second time.
- **Defect G - exchange order has no reference to its return code.** `ORDER_SELECT` (`apps/api/src/orders/order-constants.ts`, lines ~18-47) does not select `parent_order_id`, `source_return_id` or `source_return_item_id` (columns exist: 080:48-49, 084:36), and `AdminOrderRow` (`core/admin-erp-api.service.ts` ~line 570-600) has no such fields. `loadLinkedReturns(orderId)` (ts line 1612) calls `listReturns({order_id})` which filters `return_exchange.order_id` = the **original** order (`return-repository.ts:262`), so for an exchange order it returns nothing. Result: from an exchange order the operator sees no return code and no link back to the return; `returnTrace` only links original -> exchange (`core/admin-erp-order-trace.ts:227`), not exchange -> return.

### 2.3 Existing tests touching this

- `admin-erp-orders.page.spec.ts`: `'runs the handover the API keeps as a second action right after the shipment is stored'` (~l.205), `'fills the shipment from a scanned carrier label...'` (~234), `'opens the scanner at once for the shipment form and refuses it without a scan or proof photo'` (~354), `'shows the carrier label modal after start_processing succeeds'` (~392), **`'offers the label of a confirmed exchange order when its drawer opens'` (~412; asserts Defect F behavior - must be rewritten)**.
- `return-flow.component.spec.ts`: `'receives only the selected quantity...'` (l.64, asserts exact `actOnReturnItem` body), `'prefills a unique outbound AWB for the exchange shipment...'` (l.169). `done` is subscribed as `(value) => message = value` (string) - keep `done` string.
- `admin-erp-returns.page.spec.ts`: `onFlowDone('...')` test (~l.290); router is `provideRouter([])` (lines 122, 377).
- API: `tests/api/order-service.test.ts:173-194` ("carrier label is issued only for processing orders or confirmed exchange orders...") - asserts the exchange branch; `tests/api/order-router.test.ts:59` (carrier-label GET); `tests/api/return-logistics.test.ts:56-76` (exchange_order projection).

---

## 3. Requirements

### Sale order / any order (Orders workspace)

- **FR-1** Label dialog is informational. In the `carrier_label` modal remove the primary `Xác nhận vận đơn` button and `continueToShipment()`. Dialog buttons: `In nhãn` and a primary **`Xong - quay lại xử lý đơn`** (closes the modal, `closeModal()`), no status change, no scanner opened, no API write.
- **FR-2** Label modal hint becomes: "In nhãn, dán lên kiện hàng rồi đóng cửa sổ. Chuẩn bị xong hàng thì bấm “Xác nhận vận đơn” ở màn hình đơn để quét QR." (exact wording is not tested; keep meaning).
- **FR-3** Label is re-openable at any time while the order is `processing`: add drawer footer button **`Nhãn vận đơn / In lại`** (`type="button"`, shown when `canShowLabel()`), calling `openCarrierLabel(selected()!)`. This wires the currently dead `canShowLabel`.
- **FR-4** The confirm step is an explicit footer button only. In `processing` the footer button for `upsert_shipment` is styled primary (`erp-btn--primary`) and is the only primary button; other actions stay secondary. Pressing it opens the existing action modal with the scanner (existing `openAction` line 900 behavior is correct *here*: the operator pressed the confirm button on purpose). No code path may open the scanner or submit `upsert_shipment` as a side effect of `start_processing`, of closing the label modal, or of printing.
- **FR-5** Status after confirm: unchanged semantics - scan + parcel photo + submit saves the shipment (`upsert_shipment`, status-neutral) then runs `confirm_handover` (chain in `runAction`, `handoverFollowUp`) -> `shipping`. No new `OrderStatus`, no migration (decision D1).
- **FR-6** `printOrderLabel` / label rendering never calls `performOrderAction`; asserted by test.

### Exchange order

- **FR-7** Remove the auto-popup `maybeShowExchangeLabel` and `exchangeLabelShown`. An exchange order is `confirmed` after creation; the operator presses the normal "Bắt đầu chuẩn bị hàng" (`start_processing`, allowed from `confirmed`) and gets the same label modal as a sale order (FR-1..FR-6 apply verbatim).
- **FR-8** (decision D2) Tighten the label API to processing only: `createCarrierLabel` drops the `exchangeReady` branch; update JSDoc and `CARRIER_LABEL_NOT_ALLOWED` message (`order-repository.ts:286`) to "Chỉ đơn đang chuẩn bị hàng mới có nhãn vận đơn."; `canShowLabel` becomes `status === 'processing' && canMutate()`.
- **FR-9** Exchange order references its return. API: `ORDER_SELECT` adds `parent_order_id`, `source_return_id`, `source_return_item_id`; `get` (detail) adds `source_return: { return_id, return_code, tracking_return_code } | null` for `order_kind==='exchange'` orders with `source_return_id` (new repository method, see §5). UI: drawer shows a "Phiếu đổi trả gốc" block with return code + chip links `returnFocusLink(source_return.return_id, 'Mở phiếu đổi trả')` and `orderFocusLink(parent_order_id, 'Đơn hàng gốc')`; label print slip gains a row `['Phiếu đổi trả', source_return.return_code]` for exchange orders.
- **FR-10** One tracking record both sides. No schema change: after `confirm_handover` the existing triggers (131, 089) already mirror `carrier/tracking_code` to the return's outbound shipment; the Returns line already shows `exchange_order.tracking_code`/`tracking_url`. Requirement is to **verify and regress-test** this link (tests §7), and display `tracking_url` as a clickable link in the Returns exchange block if it is not already (read `return-flow` / returns page html when implementing; do not add a second source).

### Returns -> Exchange hand-off

- **FR-11** After a `receive` action succeeds and the response part is `item_status==='RECEIVED'`, `resolution_type==='exchange'`, `exchange_order_id` empty: the Returns page automatically opens the `prepare_exchange` confirm modal for that part (not executed automatically; stock and order creation stay behind one explicit click). If QA failed (`NEEDS_SUPPORT`) or the part is a refund: no hand-off (current behavior).
- **FR-12** After a `prepare_exchange` action succeeds and the response part has `exchange_order_id`: the Returns page navigates to `/orders?focus=<exchange_order_id>` (same navigation as `openFlow` line ~714), landing on the exchange order drawer in `confirmed` with `Bắt đầu chuẩn bị hàng` available. No further modal.
- **FR-13** To carry the response out of the modal without breaking `done: output<string>`, `ReturnFlowComponent` gets a second output `next = output<ReturnFlowNext>()` emitted just before `done`.

---

## 4. Edge cases / failure modes

1. **Operator closes the label modal with Esc/backdrop** - same as "Xong": no write. Use existing `(closed)="closeModal()"`.
2. **Reload/new session while `processing`** - no auto-popup (FR-7 removes the only one); operator uses FR-3 button. Label is deterministic (`createWaybill` seed = `order_code`), so reprint matches what is already stuck.
3. **Label printed, hours pass, stale `version`** - existing `STALE_ORDER_CODES` handling in `handleActionError` (`VERSION_CONFLICT`...) reloads the drawer; unchanged.
4. **Chained handover fails after tracking saved** (`runAction` error branch with `chained=true`): existing notice + `Xác nhận bàn giao ĐVVC` remains visible (guard now passes). Unchanged; do not hide.
5. **QA fails on an exchange return** (`NEEDS_SUPPORT`): no auto prepare modal; flow returns to the normal item menu (`resolve`, `convert_refund`...).
6. **Split quantity on receive**: the RPC may split a remainder part; the target for `prepare_exchange` MUST be `response.item.return_item_id` (the received part), never the pre-action `line.return_item_id`, and its `version` MUST be read from the *reloaded* record (`openReturn` fetch) - not from the stale `line`.
7. **`prepare_exchange` errors** (`INSUFFICIENT_STOCK` 409, `EXCHANGE_SAME_PRODUCT_REQUIRED`, `WAREHOUSE_QA_REQUIRED`, `EXCHANGE_ALREADY_PREPARED`, `VERSION_CONFLICT`): modal stays open with `adminErrorMessage` (existing `error` signal); no navigation. `EXCHANGE_ALREADY_PREPARED` (double click / two operators): treat as non-fatal - reload only.
8. **Role without orders read permission** (`canReadOrders` false, `admin-erp-returns.page.ts:231`): FR-12 navigation would land on a forbidden page; guard `if (!canReadOrders) { keep drawer on returns, show gatewayNote "Đơn đổi {code} đã tạo - mở trong module Đơn hàng." }`. Orders route guard is the real authority.
9. **`source_return` lookup fails** (RLS/PostgREST error): `get` must still return the order; field `source_return: null`, error swallowed with the same pattern as `listOrderEvidence` try/catch (order-service ~l.197-201). Not a hard error.
10. **Old exchange orders with null `source_return_id`** (pre-084 data): `source_return` null, UI hides the block.
11. **Tightened label API (FR-8) vs. in-flight confirmed exchange orders**: any client still calling `carrier-label` for a `confirmed` exchange order now gets 422 `CARRIER_LABEL_NOT_ALLOWED`; the only caller is this UI (`getOrderCarrierLabel`), updated in same PR.
12. **Tracking regeneration**: trigger 089 may replace a duplicate/empty code with `EXC...` at outbound insert; because 131's insert happens in an AFTER trigger and 089 writes back to `orders`, the order row seen after handover may differ from the value scanned. Display always reads the order row after reload (applyResult already does `this.selected.set(result.order)`), not the scanned value.

---

## 5. Data / API contract changes (exact)

No DB migration.

### API (`apps/api`)

1. `src/orders/order-constants.ts` - `ORDER_SELECT` array: append `"parent_order_id"`, `"source_return_id"`, `"source_return_item_id"`. (These flow into list and detail; only detail is consumed.)
2. `src/orders/order-repository.ts` - new method on `createOrderRepository()`:
   ```ts
   /** Source return of an exchange order, for the "Phiếu đổi trả gốc" block; null when absent. */
   async findSourceReturn(returnId: string, accessToken: string | null): Promise<JsonObject | null>
   // selectOne("return_exchange", { select: "return_id,return_code,tracking_return_code", return_id: `eq.${returnId}` }, authOptions(accessToken)).catch(() => null)
   ```
   Columns verified: `RETURN_SELECT` (`return-constants.ts:139`) includes `return_id`, `return_code`; `tracking_return_code` is read in `return-repository.ts` (search at ~l.349/357).
3. `src/orders/order-service.ts` `get` (line 179): after `decorate(...)`, if `order.order_kind === "exchange" && asString(order.source_return_id)` and `typeof repository.findSourceReturn === "function"` (same tolerant pattern as `orderIdsWithTags`), set `decorated.source_return = await repository.findSourceReturn(...)`, catch -> `null`. `createCarrierLabel` (line ~357): remove `exchangeReady`; condition `order.status !== "processing"` -> 422 `CARRIER_LABEL_NOT_ALLOWED`; fix JSDoc.
4. `src/orders/order-repository.ts:286` message text per FR-8.

Response shape added to `GET /api/v1/admin/orders/:id` (additive): `source_return: { return_id: string; return_code: string; tracking_return_code: string | null } | null`, plus raw `parent_order_id`, `source_return_id`, `source_return_item_id` (nullable uuid strings). `GET .../carrier-label` unchanged shape; `confirmed` exchange orders now 422.

### Admin ERP types (`core/admin-erp-api.service.ts`)

- `AdminOrderRow` (~line 570): add
  ```ts
  /** Original order of an exchange order. */
  parent_order_id?: string | null;
  source_return_id?: string | null;
  source_return_item_id?: string | null;
  /** Return the replacement belongs to; present on exchange order detail only. */
  source_return?: { return_id: string; return_code: string; tracking_return_code?: string | null } | null;
  ```
- New exported interface (JSDoc required):
  ```ts
  /** Response of `POST /api/v1/admin/returns/:id/items/:itemId/action` (RPC `velura_return_item_action`). */
  export interface AdminReturnItemActionResult {
    return_id: string;
    item: AdminReturnLine;
    lines: AdminReturnLine[];
    packing_evidence_missing?: boolean;
  }
  ```
  and change `actOnReturnItem` (line 2228) to return `Observable<AdminReturnItemActionResult>` (it is currently mistyped as `Observable<AdminReturnRow>`; the API really returns `{return_id,item,lines}` plus optional `packing_evidence_missing`, `return-service.ts` ~l.340). Fix all callers (grep `actOnReturnItem`: only `return-flow.component.ts` + spec mocks).

### Component contracts (`features/returns`)

```ts
/** What the page should do once a part action has been saved. */
export type ReturnFlowNext =
  | { readonly kind: 'prepare_exchange'; readonly returnItemId: string }
  | { readonly kind: 'open_exchange_order'; readonly exchangeOrderId: string };
```
`ReturnFlowComponent`: `readonly next = output<ReturnFlowNext>();` `buildRequest` for the generic item action keeps the response and, in `submit()`'s `next:` callback (before `this.done.emit(message)`):
- `flow==='receive'` and `result.item.item_status==='RECEIVED'` and `result.item.resolution_type==='exchange'` and `!result.item.exchange_order_id` and `result.item.return_item_id` -> `next.emit({kind:'prepare_exchange', returnItemId})`.
- `flow==='prepare_exchange'` and `result.item.exchange_order_id` -> `next.emit({kind:'open_exchange_order', exchangeOrderId})`.

(`buildRequest` currently returns `Observable<string>`; change generic-action tail to `tap`/map the result into a small `{message, next}` object internally; `done` remains `output<string>()`.)

`AdminErpReturnsPage` (`admin-erp-returns.page.ts`):
- `private readonly pendingNext = signal<ReturnFlowNext | null>(null);`
- `onFlowNext(next: ReturnFlowNext): void { this.pendingNext.set(next); }`, bound in `admin-erp-returns.page.html` on `<app-erp-return-flow ... (next)="onFlowNext($event)" ...>` (element at html line ~625).
- `onFlowDone`: read `pendingNext`; clear it. `open_exchange_order` + `canReadOrders()` -> `flow.set(null)`; `void router.navigate(['/orders'], {queryParams:{focus}})`; return (skip reload). `prepare_exchange` -> keep a `pendingPrepareItemId` and apply in `openReturn`'s `next:` callback (after `this.selected.set(record)`, next to the existing `carrierDemo` hook ~l.633): find `(record.lines||[]).find(l => l.return_item_id === id)` and call `this.openFlow('prepare_exchange', line)` (`openFlow` re-validates via `returnItemActions`, so a stale/denied hand-off is silently ignored).

No new permission, no new route, no new env/config.

---

## 6. UI behavior (target)

Sale order (`confirmed`): row action / footer `Chuẩn bị hàng` -> note modal -> OK -> **label modal**: QR + waybill table + buttons `In nhãn`, `Xong - quay lại xử lý đơn`. Close -> drawer shows status `processing`, footer: `Nhãn vận đơn / In lại`, **`Xác nhận vận đơn` (primary)**, `Ghi nhận thiếu hàng`, `Hủy đơn` (existing destructive). Operator packs, sticks label. Later presses `Xác nhận vận đơn` -> scanner opens -> scan label -> parcel photo -> `Xác nhận` -> save shipment + handover -> `shipping`, notice "Vận đơn ... đã lưu và hàng đã bàn giao ...".

Exchange: Returns page, part `RETURN_SHIPPING` -> `Kho nhận & kiểm hàng` modal -> submit pass -> modal closes, return reloads, **`Chuẩn bị đơn đổi` confirm modal opens by itself** -> `Xác nhận` -> order `EXC...` created -> browser goes to `/orders?focus=<id>`: drawer for the exchange order (status `Đã xác nhận`) with block "Phiếu đổi trả gốc: <return_code>" (+ links) -> operator presses `Chuẩn bị hàng` -> label modal (return code row on slip) -> back -> later `Xác nhận vận đơn` -> scan -> `shipping`; trigger 131 moves the return part to `EXCHANGE_SHIPPING` with the same tracking, visible on the Returns line.

Accessibility/copy: all new buttons `type="button"`; Vietnamese strings with full diacritics (do not copy the accent-less quotes from the request).

---

## 7. Test plan (narrow only)

Admin ERP (Karma/Jest per repo convention; run only these spec files):

`features/orders/admin-erp-orders.page.spec.ts`
1. Update `'shows the carrier label modal after start_processing succeeds'`: additionally assert `actions` equal `['start_processing']` only and `page.scanOpen()===false`, `page.modal()?.kind==='carrier_label'`.
2. New `'label dialog is dismiss-only: closing it never opens the scanner or performs an action'`: call `page.closeModal()` after label open; assert no `performOrderAction`, `scanOpen()===false`, `modal()===null`; assert `continueToShipment` no longer exists (`expect((page as unknown as Record<string,unknown>)['continueToShipment']).toBeUndefined()`).
3. New `'offers the label again from the drawer while processing'`: `selected` = processing order with `upsert_shipment` allowed; `canShowLabel()` true; `openCarrierLabel` fills `carrierLabel`; `confirmed` order -> `canShowLabel()` false.
4. Replace `'offers the label of a confirmed exchange order when its drawer opens'` with `'does not auto-open a label for a confirmed exchange order'`: `openDetail('o9')` with exchange/confirmed -> `modal()` is null and `getOrderCarrierLabel` not called; after `start_processing` the label modal opens.
5. Keep as-is (regression): handover-chain test (~l.205), scan tests (~234-275), `'opens the scanner at once...'` (~354) - the scanner still opens at once when `openAction(upsert_shipment)` is pressed explicitly.
6. New `'shows the source return of an exchange order'`: `getOrder` returns `{... order_kind:'exchange', source_return:{return_id:'r1', return_code:'RT-1'}}`; assert rendered code + link `commands:['/returns']`/`focus:'r1'` (use `returnFocusLink`).

`features/returns/return-flow.component.spec.ts`
7. `'emits next prepare_exchange after a passed exchange receive'`: stub `actOnReturnItem` -> `of({return_id, item:{return_item_id:'part-1',item_status:'RECEIVED',resolution_type:'exchange',exchange_order_id:null}, lines:[]})`; `component.next.subscribe(...)`; assert payload and that `done` still emits `''` after it.
8. `'does not emit next when QA fails (NEEDS_SUPPORT) or part is refund'`.
9. `'emits open_exchange_order after prepare_exchange'` (`exchange_order_id:'exc-1'`).
10. Existing receive body assertion (l.64) must stay green (body unchanged).

`features/returns/admin-erp-returns.page.spec.ts`
11. `'opens prepare_exchange for the received part after reload'`: `page.onFlowNext({kind:'prepare_exchange', returnItemId:'part-1'}); page.onFlowDone('')` with `getReturn` returning a record whose line `part-1` is `RECEIVED` exchange -> `page.flow()==='prepare_exchange'` and `flowLine().return_item_id==='part-1'`.
12. `'navigates to the exchange order after prepare_exchange'`: spy `Router.navigate` called with `(['/orders'], {queryParams:{focus:'exc-1'}})`; with `canReadOrders` false it does not navigate.

API (`node --test`/repo runner, files below only)
13. `tests/api/order-service.test.ts:173-194`: change exchange case to expect 422 `CARRIER_LABEL_NOT_ALLOWED` for `confirmed`+`exchange`; add: processing exchange order still gets a label.
14. New `get` test: repository stub with `order_kind:'exchange', source_return_id:'<uuid>'` and `findSourceReturn` -> `{return_id, return_code:'RT-1', tracking_return_code:null}`; assert `result.source_return.return_code==='RT-1'`; stub rejecting -> `source_return === null` and order still returned; sale order -> `findSourceReturn` not called.
15. `tests/api/order-router.test.ts:59`: keep; no shape change.
16. Link regression (FR-10): extend `tests/api/return-logistics.test.ts` (l.56-76 area) to assert `exchange_order.tracking_code` and `tracking_url` come from the order row (already projected by `getExchangeOrder`); SQL trigger behaviour is covered by migration 131/089 and is NOT re-tested here (no DB in unit tests) - flagged as a verification gap.

Manual smoke (staging, simulator carrier): sale order full path; exchange path with real receive -> prepare -> orders deep link -> prepare -> scan -> handover; check the return line shows tracking and `EXCHANGE_SHIPPING`.

---

## 8. Files to change

| File | Change |
|---|---|
| `apps/admin-erp-ng/src/app/features/orders/admin-erp-orders.page.html` | Label modal: drop `continueToShipment` button, add `Xong - quay lại xử lý đơn`, new hint; footer: `Nhãn vận đơn / In lại` button (`canShowLabel()`), primary class on `upsert_shipment`; "Phiếu đổi trả gốc" block |
| `apps/admin-erp-ng/src/app/features/orders/admin-erp-orders.page.ts` | delete `continueToShipment`, `maybeShowExchangeLabel`, `exchangeLabelShown`; `canShowLabel` = processing only; `printOrderLabel` return-code row; `orderLinks`/new computed `sourceReturnLinks` from `selected()?.source_return` |
| `apps/admin-erp-ng/src/app/features/orders/admin-erp-orders.page.spec.ts` | tests 1-6 |
| `apps/admin-erp-ng/src/app/core/admin-erp-api.service.ts` | `AdminOrderRow` fields; `AdminReturnItemActionResult`; `actOnReturnItem` return type |
| `apps/admin-erp-ng/src/app/features/returns/return-flow.component.ts` (+ `.spec.ts`) | `ReturnFlowNext`, `next` output, keep response in `buildRequest`/`submit` |
| `apps/admin-erp-ng/src/app/features/returns/admin-erp-returns.page.ts` / `.html` / `.spec.ts` | `pendingNext`, `onFlowNext`, `onFlowDone` hand-off, `openReturn` hook, `(next)` binding |
| `apps/api/src/orders/order-constants.ts` | `ORDER_SELECT` + 3 columns |
| `apps/api/src/orders/order-repository.ts` | `findSourceReturn`; error message l.286 |
| `apps/api/src/orders/order-service.ts` | `get` adds `source_return`; `createCarrierLabel` processing-only + JSDoc; `OrderService` interface unchanged |
| `tests/api/order-service.test.ts` | tests 13-14 |
| `tests/api/return-logistics.test.ts` | test 16 |

Not changed: state machine tables, migrations 038/084/089/131, `carrier-gateway-simulator.ts`, `admin-erp-qr.ts`, `print-slip.ts`, return RPCs, `core/admin-erp-order-trace.ts` handover chain.

---

## 9. Task breakdown (ordered; each task has an owner file, no design left open)

1. **T1 API projection** - `order-constants.ts`: add 3 columns to `ORDER_SELECT`. Acceptance: `tests/api/order-service.test.ts` still green.
2. **T2 API source return** - `order-repository.ts`: add `findSourceReturn`; `order-service.ts` `get`: attach `source_return` (guarded, swallow errors). Add test 14.
3. **T3 API label tightening** - `order-service.ts` `createCarrierLabel` processing-only, JSDoc; `order-repository.ts:286` message; update test 13.
4. **T4 Types** - `admin-erp-api.service.ts`: `AdminOrderRow` fields, `AdminReturnItemActionResult`, retype `actOnReturnItem`; fix mocks in specs that compile-break.
5. **T5 Orders VM** - `admin-erp-orders.page.ts`: remove `continueToShipment` / `maybeShowExchangeLabel` / `exchangeLabelShown`; `canShowLabel` processing-only; slip row; `sourceReturnLinks` computed.
6. **T6 Orders view** - `admin-erp-orders.page.html`: label modal buttons + hint (FR-1/2), footer re-open button (FR-3), primary style for `upsert_shipment` (FR-4), source-return block (FR-9). Tests 1-6 in `admin-erp-orders.page.spec.ts`.
7. **T7 Return flow component** - `return-flow.component.ts`: `ReturnFlowNext`, `next` output, retain response; tests 7-10.
8. **T8 Returns page** - `admin-erp-returns.page.ts/.html`: `pendingNext`, `onFlowNext`, `onFlowDone` branches, `openReturn` hook; tests 11-12.
9. **T9 Narrow verification** - run only: `admin-erp-orders.page.spec.ts`, `return-flow.component.spec.ts`, `admin-erp-returns.page.spec.ts`, `tests/api/order-service.test.ts`, `tests/api/order-router.test.ts`, `tests/api/return-logistics.test.ts`, plus `tsc`/`ng build` type check of admin-erp-ng and `npm run build` of api.

Commit message: `KAN-116 why: label/QR step must not auto-advance; exchange QA hands off to prepare and Orders deep link`.

---

## 10. Decisions and risks (for adversarial review)

- **D1 - no new status.** Owner wrote "(status mới)". Reading adopted: the confirm button produces the status change (`processing -> shipping`). Adding a real intermediate status (e.g. `packed`) would need: `ORDER_STATUSES` + `ORDER_STATUS_LABELS` (`order-state-machine.ts`), a migration replacing the `admin_order_action` rule table (`velura_order_action_rules()` in migration 038, which `tests/api/order-state-machine.test.ts` diffs against), the DB enum, customer timeline (`customerOrderSteps`), dashboards/MV (`102_dashboard_mv_fact_fulfillment`), user-ng labels. Rejected as disproportionate for a UX fix; revisit only if the owner explicitly wants a customer-visible "Đã đóng gói" status.
- **D1b - chain kept on confirm.** `upsert_shipment` + auto `confirm_handover` still happens in one click at the confirm step. If the owner wants *scan-confirm* and *handover* as two separate presses, drop `handoverFollowUp` chaining in `runAction` (line 1179) - one-line change, the footer already offers `Xác nhận bàn giao ĐVVC` once tracking exists. Ask before implementing; default is chained.
- **D2 - API tightening of exchange label.** Removes a documented KAN-114 behavior (`createCarrierLabel` JSDoc + test 173). If a reviewer prefers zero API risk, keep the API branch and only delete the UI auto-popup (FR-7) - the exchange label would then be reachable via API at `confirmed` but unused by UI.
- **R1 - migration 131 chain is only DB-tested by trigger design.** FR-10 asserts that exchange handover syncs the return and tracking; I verified the SQL by reading it, not by executing it. A real staging run is required (manual smoke).
- **R2 - race**: between `receive` and auto-opened `prepare_exchange`, another operator can prepare first -> `EXCHANGE_ALREADY_PREPARED`/`VERSION_CONFLICT` (handled, §4.7).
- **R3 - stock side effect**: `prepare_exchange` decrements stock at creation; auto-opening the modal increases the chance of accidental confirm. Mitigated by keeping it an explicit button; modal copy should state "Tạo đơn đổi và trừ tồn kho biến thể thay thế".
- **R4 - `actOnReturnItem` retype** can ripple through spec mocks typed against `AdminReturnRow`; compile-only fix.
- **R5 - typing note on `split`**: when `canSplit()` the quantity sent may produce a remainder part (`split_remainder_id`); `result.item` is always the acted part, so the hand-off targets the right id (verified from RPC return at 084 l.462).
- **R6 - not covered**: simulated carrier only (`GHN` + `SIMULATED_TRACKING_URL`); no real carrier gateway is integrated, so "same link as ĐVVC" means the simulator's `trackingUrl` stored on the order. Real carrier linkage is out of scope.
- **R7 - prefilled note on start_processing** (action `requires_note: true`, 5 chars min) is not changed; for exchange orders the drawer "Phiếu đổi trả gốc" block gives context but the note is still typed. Optional follow-up, not required here.
