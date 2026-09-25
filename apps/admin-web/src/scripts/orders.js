import { orderApi } from "./order-api.js";
import {
  ORDER_STATES,
  ORDER_STATE_LABELS,
  PAYMENT_STATUS_LABELS,
  CANCEL_REASONS,
  CALL_RESULTS,
  getOrderPriorityTag,
  isOrderAdmin,
  getAvailableActions
} from "./order-constants.js";
import { getSession } from "./auth.js";

const state = {
  orders: [],
  count: 0,
  active: "all",
  selected: null,
  logs: [],
  currentPage: 1,
  itemsPerPage: 10,
  logsPage: 1,
  userRole: "admin_operator_donhang"
};

const panel = document.querySelector("#order-panel");
const overlay = document.querySelector("#order-overlay");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function icon(name) {
  return `<svg class="admin-line-icon"><use href="../../assets/icons/admin-icons.svg#${escapeHtml(name)}" /></svg>`;
}

function money(value) {
  return `${Number(value || 0).toLocaleString("vi-VN")}đ`;
}

function dateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("vi-VN", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Asia/Ho_Chi_Minh"
      }).format(date);
}

function badge(value, kind = "order") {
  const label = kind === "payment" ? (PAYMENT_STATUS_LABELS[value] || value) : (ORDER_STATE_LABELS[value] || value);
  return `<span class="admin-badge admin-badge--${kind}-${escapeHtml(value)}">${escapeHtml(label || "—")}</span>`;
}

function renderPriorityTag(order) {
  const tag = getOrderPriorityTag(order);
  if (!tag) return "";
  return `<span class="admin-tag admin-tag--${tag.type}">${escapeHtml(tag.label)}</span>`;
}

function paymentOf(order) {
  return Array.isArray(order.payments) ? order.payments[0] : null;
}

function isPaymentError(order) {
  const payment = paymentOf(order);
  return payment?.payment_status === "failed" || payment?.payment_status === "discrepancy" || payment?.has_discrepancy === true;
}

function needsAttention(order) {
  return (
    order.status === ORDER_STATES.PENDING ||
    order.status === ORDER_STATES.DELIVERY_FAILED ||
    isPaymentError(order) ||
    Boolean(getOrderPriorityTag(order))
  );
}

function filteredOrders() {
  if (state.active === "pending") return state.orders.filter((o) => o.status === ORDER_STATES.PENDING);
  if (state.active === "active_processing") return state.orders.filter((o) => o.status === ORDER_STATES.PROCESSING || o.status === ORDER_STATES.SHIPPING || o.status === ORDER_STATES.CONFIRMED);
  if (state.active === "attention") return state.orders.filter(needsAttention);
  if (state.active === "payment") return state.orders.filter(isPaymentError);
  if (state.active === "cancelled") return state.orders.filter((o) => o.status === ORDER_STATES.CANCELLED);
  return state.orders;
}

function filterBar() {
  const stateOptions = Object.entries(ORDER_STATE_LABELS)
    .map(([code, label]) => `<option value="${code}">${escapeHtml(label)}</option>`)
    .join("");

  return `<form class="admin-filter-bar admin-order-filter-bar" data-order-filter>
    <label class="admin-search-field">${icon("search")}<input class="admin-form-control" name="q" type="search" placeholder="Tên khách, số điện thoại, mã vận đơn..." /></label>
    <label class="admin-form-group"><select class="admin-form-control" name="status" aria-label="Trạng thái">
      <option value="">Tất cả 8 trạng thái</option>${stateOptions}
    </select></label>
    <label class="admin-form-group"><select class="admin-form-control" name="paymentMethod" aria-label="Thanh toán"><option value="">Tất cả thanh toán</option><option value="COD">COD</option><option value="ONLINE_PAYMENT">Online</option></select></label>
    <label class="admin-form-group"><input class="admin-form-control" name="from" type="date" aria-label="Từ ngày" /></label>
    <div class="admin-filter-bar__actions"><button class="admin-btn admin-btn--filter admin-btn--sm" type="submit">Lọc</button><button class="admin-btn admin-btn--ghost admin-btn--sm" type="reset">Đặt lại</button></div>
  </form>`;
}

function actionMenu(order) {
  const id = escapeHtml(order.order_id);
  const payment = paymentOf(order);
  const availableActions = getAvailableActions(order, state.userRole);

  return `<div class="admin-order-actions">
    <button class="admin-icon-button admin-icon-button--sm" type="button" title="Xem chi tiết" data-order-detail="${id}">${icon("eye")}</button>
    ${
      isOrderAdmin(state.userRole) && availableActions.length > 0
        ? `<button class="admin-icon-button admin-icon-button--sm" type="button" title="Thao tác" data-order-menu="${id}">${icon("edit")}</button>
          <div class="admin-dropdown admin-table-action-menu admin-order-action-menu" id="order-menu-${id}" hidden>
            <button data-order-detail="${id}">${icon("eye")}<span>Xem chi tiết</span></button>
            ${availableActions
              .map(
                (action) =>
                  `<button ${action.disabled ? "disabled" : ""} data-order-modal-type="${action.modalType}" data-order-id="${id}" class="${action.variant === "danger" ? "admin-order-action-menu__danger" : ""}">
                    ${icon(action.icon)}<span>${escapeHtml(action.label)}</span>
                  </button>`
              )
              .join("")}
            ${
              payment?.has_discrepancy || payment?.payment_status === "discrepancy"
                ? `<button data-order-action="payment" data-order-id="${id}">${icon("credit-card")}<span>Xử lý thanh toán</span></button>`
                : ""
            }
          </div>`
        : ""
    }
  </div>`;
}

function renderPagination(totalItems) {
  const totalPages = Math.ceil(totalItems / state.itemsPerPage) || 1;
  if (totalPages <= 1) return "";

  let buttons = "";
  buttons += `<button type="button" data-order-page="${state.currentPage - 1}" ${state.currentPage === 1 ? "disabled" : ""}>←</button>`;

  for (let i = 1; i <= totalPages; i++) {
    if (totalPages > 6) {
      if (i !== 1 && i !== totalPages && Math.abs(state.currentPage - i) > 1) {
        if (i === 2 && state.currentPage > 3) {
          buttons += `<span class="pagination-ellipsis" style="padding: 0 4px; color: var(--muted);">...</span>`;
        } else if (i === totalPages - 1 && state.currentPage < totalPages - 2) {
          buttons += `<span class="pagination-ellipsis" style="padding: 0 4px; color: var(--muted);">...</span>`;
        }
        continue;
      }
    }
    buttons += `<button type="button" class="${state.currentPage === i ? "is-active" : ""}" data-order-page="${i}">${i}</button>`;
  }

  buttons += `<button type="button" data-order-page="${state.currentPage + 1}" ${state.currentPage === totalPages ? "disabled" : ""}>→</button>`;
  return `<nav class="admin-pagination">${buttons}</nav>`;
}

function renderTable() {
  const activeOrders = filteredOrders();
  const totalItems = activeOrders.length;
  const totalPages = Math.ceil(totalItems / state.itemsPerPage) || 1;
  if (state.currentPage > totalPages) state.currentPage = totalPages;
  if (state.currentPage < 1) state.currentPage = 1;

  const start = (state.currentPage - 1) * state.itemsPerPage;
  const end = start + state.itemsPerPage;
  const pagedRows = activeOrders.slice(start, end);

  if (!pagedRows.length)
    return `<div class="admin-order-empty">${icon("cart")}<strong>Không có đơn hàng phù hợp</strong><span>Điều chỉnh bộ lọc hoặc tải lại dữ liệu.</span></div>`;

  return `<div class="admin-table-wrap"><table class="admin-table admin-data-table"><thead><tr>
    <th>Mã đơn</th><th>Khách hàng</th><th>Tổng tiền</th><th>Trạng thái đơn</th><th>Thanh toán</th><th>Tag / Cần xử lý</th><th>Thao tác</th>
  </tr></thead><tbody>${pagedRows
    .map((order) => {
      const payment = paymentOf(order);
      const tagHtml = renderPriorityTag(order);
      return `<tr><td><span class="admin-order-code">${escapeHtml(order.order_id)}</span><small class="admin-order-subtext">${escapeHtml(dateTime(order.order_date))}</small></td>
      <td><div class="admin-order-customer"><strong>${escapeHtml(order.shipping_name)}</strong><small>${escapeHtml(order.shipping_phone)}</small></div></td>
      <td class="admin-order-amount">${money(order.total_amount)}</td><td>${badge(order.status)}</td>
      <td>${badge(payment?.payment_status || "pending", "payment")}</td>
      <td>
        <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
          ${tagHtml}
          ${needsAttention(order) ? `<span class="admin-order-attention admin-order-attention--alert">${icon("alert")}Cần xử lý</span>` : "—"}
        </div>
      </td>
      <td>${actionMenu(order)}</td></tr>`;
    })
    .join("")}</tbody></table></div>`;
}

function updateCounters() {
  const totalCount = state.count;
  const pendingCount = state.orders.filter((o) => o.status === ORDER_STATES.PENDING).length;
  const activeProcessingCount = state.orders.filter((o) => o.status === ORDER_STATES.PROCESSING || o.status === ORDER_STATES.SHIPPING || o.status === ORDER_STATES.CONFIRMED).length;
  const paymentCount = state.orders.filter(isPaymentError).length;
  const attentionCount = state.orders.filter(needsAttention).length;
  const cancelledCount = state.orders.filter((o) => o.status === ORDER_STATES.CANCELLED).length;

  document.querySelectorAll(".admin-order-kpis .admin-kpi-card__value").forEach((node, index) => {
    const vals = [totalCount, pendingCount, paymentCount, attentionCount];
    node.textContent = String(vals[index] || 0);
  });

  document.querySelectorAll("[data-order-tab] span").forEach((node) => {
    const tab = node.parentElement.dataset.orderTab;
    if (tab === "all") node.textContent = String(totalCount);
    else if (tab === "pending") node.textContent = String(pendingCount);
    else if (tab === "active_processing") node.textContent = String(activeProcessingCount);
    else if (tab === "attention") node.textContent = String(attentionCount);
    else if (tab === "payment") node.textContent = String(paymentCount);
    else if (tab === "cancelled") node.textContent = String(cancelledCount);
  });
}

function render() {
  if (state.active === "logs") return renderLogs();
  const activeOrders = filteredOrders();
  const totalItems = activeOrders.length;
  const start = (state.currentPage - 1) * state.itemsPerPage;
  const end = Math.min(start + state.itemsPerPage, totalItems);
  const showStart = totalItems === 0 ? 0 : start + 1;

  panel.innerHTML = `${filterBar()}${renderTable()}<div class="admin-card__footer"><p class="admin-table-note">Hiển thị ${showStart} - ${end} / ${totalItems} đơn hàng</p>${renderPagination(totalItems)}</div>`;
  updateCounters();
}

async function loadOrders(params = {}) {
  panel.innerHTML = `<div class="admin-order-empty"><strong>Đang tải dữ liệu đơn hàng...</strong></div>`;
  try {
    const session = getSession();
    if (session) state.userRole = session.roleCode || "admin_operator_donhang";

    const result = await orderApi.list({ ...params, limit: 1000 });
    state.orders = result.rows || [];
    state.count = result.count ?? state.orders.length;
    render();
  } catch (error) {
    panel.innerHTML = `<div class="admin-order-empty">${icon("alert")}<strong>Không thể tải đơn hàng</strong><span>${escapeHtml(error.message)}</span><button class="admin-btn admin-btn--secondary admin-btn--sm" data-order-retry>Thử lại</button></div>`;
  }
}

/**
 * Màn Chi tiết đơn hàng (Admin Order Detail) - KAN-60 & FR-01 Card Layout
 */
async function openDetail(orderId) {
  overlay.innerHTML = `<div class="admin-drawer-backdrop" data-order-close></div><aside class="admin-drawer admin-drawer--wide"><div class="admin-drawer__body">Đang tải chi tiết đơn hàng...</div></aside>`;
  try {
    const order = await orderApi.get(orderId);
    state.selected = order;
    const payment = paymentOf(order);
    const availableActions = getAvailableActions(order, state.userRole);
    const priorityTag = getOrderPriorityTag(order);

    // 1. Render Toolbar Action hoặc Banner CSKH
    let actionToolbarHtml = "";
    if (!isOrderAdmin(state.userRole)) {
      actionToolbarHtml = `<div class="admin-cskh-banner">${icon("info")}<span>Bạn đang đăng nhập với vai trò CSKH (Chỉ xem). Không có quyền thực hiện action chuyển trạng thái hoặc hủy đơn.</span></div>`;
    } else if (availableActions.length > 0) {
      actionToolbarHtml = `<div class="admin-detail-actions-bar">
        <span style="width:100%; font-size:0.75rem; font-weight:600; text-transform:uppercase; color:var(--soft); margin-bottom:4px;">Action khả dụng theo trạng thái:</span>
        ${availableActions
          .map(
            (act) => `<button class="admin-action-btn admin-action-btn--${act.variant}" type="button" ${act.disabled ? "disabled title='" + escapeHtml(act.disabledHint || "") + "'" : ""} data-order-modal-type="${act.modalType}" data-order-id="${escapeHtml(order.order_id)}">
              ${icon(act.icon)}<span>${escapeHtml(act.label)}</span>
            </button>`
          )
          .join("")}
      </div>`;
    }

    // 2. Build full drawer HTML with 6 structured cards
    overlay.innerHTML = `<div class="admin-drawer-backdrop" data-order-close></div><aside class="admin-drawer admin-drawer--wide">
      <header class="admin-drawer__header">
        <div>
          <p class="admin-product-code">${escapeHtml(order.order_id)}</p>
          <h2 class="admin-section__title">${escapeHtml(order.shipping_name)}</h2>
          <div class="admin-status-group" style="margin-top:6px;">
            ${badge(order.status)}
            ${badge(payment?.payment_status || "pending", "payment")}
            ${priorityTag ? `<span class="admin-tag admin-tag--${priorityTag.type}">${escapeHtml(priorityTag.label)}</span>` : ""}
          </div>
        </div>
        <button class="admin-icon-button" data-order-close aria-label="Đóng">×</button>
      </header>

      <div class="admin-drawer__body admin-order-drawer-content">
        ${actionToolbarHtml}

        <!-- Card 1: Thông tin đơn & Khách hàng -->
        <section class="admin-detail-card">
          <div class="admin-detail-card__header">
            <h3 class="admin-detail-card__title">${icon("users")} Thông tin đơn &amp; Khách hàng</h3>
            <small style="color:var(--soft);">Tạo lúc: ${escapeHtml(dateTime(order.order_date))}</small>
          </div>
          <div class="admin-detail-grid">
            <div class="admin-detail-field"><span class="admin-detail-field__label">Mã đơn hàng</span><span class="admin-detail-field__value">${escapeHtml(order.order_id)}</span></div>
            <div class="admin-detail-field"><span class="admin-detail-field__label">Tên khách hàng</span><span class="admin-detail-field__value">${escapeHtml(order.shipping_name)}</span></div>
            <div class="admin-detail-field"><span class="admin-detail-field__label">Số điện thoại</span><span class="admin-detail-field__value">${escapeHtml(order.shipping_phone)}</span></div>
            <div class="admin-detail-field" style="grid-column: span 2;"><span class="admin-detail-field__label">Địa chỉ nhận hàng</span><span class="admin-detail-field__value">${escapeHtml(order.shipping_address)}</span></div>
          </div>
        </section>

        <!-- Card 2: Thanh toán & Vận chuyển -->
        <section class="admin-detail-card">
          <div class="admin-detail-card__header">
            <h3 class="admin-detail-card__title">${icon("credit-card")} Thanh toán &amp; Vận chuyển</h3>
          </div>
          <div class="admin-detail-grid">
            <div class="admin-detail-field"><span class="admin-detail-field__label">Phương thức thanh toán</span><span class="admin-detail-field__value">${escapeHtml(order.payment_method || "COD")}</span></div>
            <div class="admin-detail-field"><span class="admin-detail-field__label">Tình trạng thanh toán</span><span class="admin-detail-field__value">${badge(payment?.payment_status || "pending", "payment")}</span></div>
            <div class="admin-detail-field"><span class="admin-detail-field__label">Mã vận đơn (Tracking)</span><span class="admin-detail-field__value">${order.tracking_code ? `<code>${escapeHtml(order.tracking_code)}</code>` : '<em style="color:var(--muted);">Chưa tạo</em>'}</span></div>
            <div class="admin-detail-field"><span class="admin-detail-field__label">Bàn giao ĐVVC</span><span class="admin-detail-field__value">${order.is_handed_over || order.handed_over_at ? "Đã bàn giao thực tế" : "Chưa bàn giao"}</span></div>
          </div>
        </section>

        <!-- Card 3: Sản phẩm trong đơn -->
        <section class="admin-detail-card">
          <div class="admin-detail-card__header">
            <h3 class="admin-detail-card__title">${icon("box")} Danh sách sản phẩm</h3>
          </div>
          <div class="admin-order-product-list">
            ${(order.items || [])
              .map(
                (item) => `<article class="admin-order-product">
                  <div>
                    <strong>${escapeHtml(item.product_name)}</strong>
                    <small>Số lượng: ${Number(item.quantity)} | Đơn giá: ${money(item.unit_price)}</small>
                  </div>
                  <div class="admin-order-product__price">${money(Number(item.unit_price) * Number(item.quantity))}</div>
                </article>`
              )
              .join("") || '<p style="color:var(--muted);">Không có sản phẩm</p>'}
          </div>
          <div class="admin-order-totals" style="margin-top:16px; border-top:1px solid #e2e8f0; padding-top:12px;">
            <div><span>Tổng cộng thanh toán:</span><strong style="font-size:1.1rem; color:var(--brown);">${money(order.total_amount)}</strong></div>
          </div>
        </section>

        <!-- Card 4: Thông tin xử lý & Ghi chú liên hệ -->
        <section class="admin-detail-card">
          <div class="admin-detail-card__header">
            <h3 class="admin-detail-card__title">${icon("message-square")} Thông tin xử lý &amp; Ghi chú liên hệ</h3>
          </div>
          <div class="admin-detail-grid">
            <div class="admin-detail-field"><span class="admin-detail-field__label">Kết quả gọi điện</span><span class="admin-detail-field__value">${escapeHtml(order.contact_result || "Chưa liên hệ")}</span></div>
            <div class="admin-detail-field"><span class="admin-detail-field__label">Tình trạng thiếu hàng</span><span class="admin-detail-field__value">${escapeHtml(order.stock_shortage_note || "Không có")}</span></div>
            <div class="admin-detail-field" style="grid-column: span 2;"><span class="admin-detail-field__label">Ghi chú vận chuyển</span><span class="admin-detail-field__value">${escapeHtml(order.carrier_note || "Không có")}</span></div>
          </div>
        </section>

        <!-- Card 5: Lịch sử xử lý & Chuyển trạng thái -->
        <section class="admin-detail-card">
          <div class="admin-detail-card__header">
            <h3 class="admin-detail-card__title">${icon("log")} Lịch sử xử lý đơn hàng</h3>
          </div>
          <div class="admin-timeline">
            ${(order.history || [])
              .sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at))
              .map(
                (entry) => `<div class="admin-timeline__item">
                  <strong>${escapeHtml(ORDER_STATE_LABELS[entry.new_status] || entry.new_status)}</strong>
                  <span>${escapeHtml(dateTime(entry.changed_at))} · Thực hiện bởi: <strong>${escapeHtml(entry.actor_role || entry.actor || "Order Admin")}</strong></span>
                  ${entry.note ? `<p style="margin:4px 0 0 0; font-size:0.8125rem; color:#475569;">Ghi chú: ${escapeHtml(entry.note)}</p>` : ""}
                </div>`
              )
              .join("") || '<p style="color:var(--muted);">Chưa có lịch sử</p>'}
          </div>
        </section>
      </div>
    </aside>`;
  } catch (error) {
    showToast(error.message, true);
    overlay.innerHTML = "";
  }
}

/**
 * Hiển thị Form Modal Action theo từng loại thao tác (KAN-60, KAN-63)
 */
function openActionModal(modalType, orderId) {
  const order = state.orders.find((item) => item.order_id === orderId) || state.selected;
  if (!order) return;

  let title = "";
  let fieldsHtml = "";
  let warningHtml = "";

  switch (modalType) {
    case "call_confirm":
      title = "Gọi điện xác nhận đơn";
      fieldsHtml = `
        <label class="admin-form-group">
          <span class="admin-form-label">Kết quả liên hệ <b>*</b></span>
          <select class="admin-form-control" name="callResult" required>
            ${CALL_RESULTS.map((res) => `<option value="${res.value}">${escapeHtml(res.label)}</option>`).join("")}
          </select>
        </label>
        <p class="admin-table-note" style="margin-bottom:12px; color:var(--muted);">
          ℹ️ Lưu kết quả gọi điện sẽ ghi nhận thông tin liên hệ mà không làm thay đổi trạng thái đơn.
        </p>
      `;
      break;

    case "confirm_cod":
      title = "Xác nhận đơn COD";
      warningHtml = `<div class="admin-order-warning">Xác nhận chuyển đơn từ <strong>Chờ xác nhận (pending)</strong> sang <strong>Đã xác nhận (confirmed)</strong>.</div>`;
      break;

    case "start_processing":
      title = "Bắt đầu chuẩn bị hàng";
      warningHtml = `<div class="admin-order-warning">Xác nhận chuyển đơn từ <strong>Đã xác nhận (confirmed)</strong> sang <strong>Đang chuẩn bị hàng (processing)</strong>.</div>`;
      break;

    case "record_shortage":
      title = "Ghi nhận thiếu hàng & liên hệ khách";
      fieldsHtml = `
        <label class="admin-form-group">
          <span class="admin-form-label">Thông tin sản phẩm thiếu <b>*</b></span>
          <textarea class="admin-form-control admin-form-textarea" name="shortageDetails" placeholder="Nhập tên sản phẩm/biến thể thiếu hàng..." required></textarea>
        </label>
      `;
      break;

    case "update_shipping_code":
      title = order.tracking_code ? "Cập nhật mã vận đơn" : "Tạo mã vận đơn";
      fieldsHtml = `
        <label class="admin-form-group">
          <span class="admin-form-label">Mã vận đơn (Tracking Code) <b>*</b></span>
          <input class="admin-form-control" name="trackingCode" value="${escapeHtml(order.tracking_code || "")}" placeholder="VD: VN123456789" maxlength="100" required />
        </label>
        <p class="admin-table-note" style="margin-bottom:12px; color:var(--muted);">
          ℹ️ Lưu ý: Tạo mã vận đơn chưa đồng nghĩa với việc đã bàn giao hàng thực tế cho ĐVVC.
        </p>
      `;
      break;

    case "handover_shipping":
      title = "Xác nhận bàn giao ĐVVC";
      if (!order.tracking_code) {
        showToast("Đơn hàng chưa có mã vận đơn. Vui lòng tạo mã vận đơn trước khi bàn giao!", true);
        return;
      }
      fieldsHtml = `
        <div class="admin-form-group">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" name="physicalHandoverConfirmed" required />
            <span style="font-weight:600; color:var(--ink);">Xác nhận đã bàn giao hàng thực tế cho đơn vị vận chuyển</span>
          </label>
        </div>
      `;
      warningHtml = `<div class="admin-order-warning">Đơn sẽ được chuyển từ <strong>Đang chuẩn bị hàng (processing)</strong> sang <strong>Đang giao hàng (shipping)</strong>.</div>`;
      break;

    case "note_carrier":
      title = "Ghi chú liên hệ ĐVVC";
      fieldsHtml = `
        <label class="admin-form-group">
          <span class="admin-form-label">Nội dung trao đổi với ĐVVC</span>
          <textarea class="admin-form-control admin-form-textarea" name="carrierContent" placeholder="Nhập chi tiết thông tin làm việc với bưu tá/đơn vị vận chuyển..."></textarea>
        </label>
      `;
      break;

    case "update_tracking":
      title = "Cập nhật hành trình tracking";
      fieldsHtml = `
        <label class="admin-form-group">
          <span class="admin-form-label">Trạng thái tracking mới</span>
          <input class="admin-form-control" name="trackingInfo" placeholder="VD: Hàng đã cập bưu cục Cầu Giấy..." required />
        </label>
      `;
      break;

    case "cancel_order":
      title = "Hủy đơn hàng";
      fieldsHtml = `
        <label class="admin-form-group">
          <span class="admin-form-label">Lý do hủy đơn <b>*</b></span>
          <select class="admin-form-control" name="cancelReason" required>
            ${CANCEL_REASONS.map((r) => `<option value="${r.value}">${escapeHtml(r.label)}</option>`).join("")}
          </select>
        </label>
      `;
      if (order.tracking_code) {
        warningHtml += `<div class="admin-order-danger-note">⚠️ Đơn hàng đã được tạo mã vận đơn (<code>${escapeHtml(order.tracking_code)}</code>). Việc hủy đơn sẽ tự động vô hiệu hóa mã vận đơn này.</div>`;
      }
      if (order.payment_method !== "COD" && paymentOf(order)?.payment_status === "paid") {
        warningHtml += `<div class="admin-order-warning">ℹ️ Đơn hàng online đã thanh toán. Hệ thống sẽ kích hoạt quy trình hoàn tiền mô phỏng tự động.</div>`;
      }
      break;

    default:
      return;
  }

  // Mandatory Note field for ALL manual actions (AC-17)
  const mandatoryNoteHtml = `
    <label class="admin-form-group" style="margin-top:12px;">
      <span class="admin-form-label">Ghi chú xử lý (Bắt buộc) <b>*</b></span>
      <textarea class="admin-form-control admin-form-textarea" name="note" minlength="5" maxlength="500" placeholder="Nhập ghi chú chi tiết cho thao tác này (tối thiểu 5 ký tự)..." required></textarea>
    </label>
  `;

  overlay.innerHTML = `<div class="admin-modal-overlay">
    <section class="admin-modal">
      <form data-order-action-modal-form data-modal-type="${modalType}" data-order-id="${escapeHtml(order.order_id)}">
        <header class="admin-modal__header">
          <h2>${escapeHtml(title)}</h2>
          <button class="admin-icon-button" type="button" data-order-close>×</button>
        </header>
        <div class="admin-modal__body">
          ${warningHtml}
          ${fieldsHtml}
          ${mandatoryNoteHtml}
        </div>
        <footer class="admin-modal__footer">
          <button class="admin-btn admin-btn--ghost" type="button" data-order-close>Đóng</button>
          <button class="admin-btn ${modalType === "cancel_order" ? "admin-btn--danger" : "admin-btn--primary"}" type="submit">Xác nhận thao tác</button>
        </footer>
      </form>
    </section>
  </div>`;
}

/**
 * Xử lý submit action form (Gửi yêu cầu tới backend + validate ghi chú)
 */
async function submitActionModal(form) {
  const orderId = form.dataset.orderId;
  const modalType = form.dataset.modalType;
  const order = state.orders.find((item) => item.order_id === orderId) || state.selected;
  const submitBtn = form.querySelector('[type="submit"]');

  const note = (form.note?.value || "").trim();
  if (!note || note.length < 5) {
    showToast("Ghi chú xử lý là bắt buộc và phải có ít nhất 5 ký tự!", true);
    return;
  }

  submitBtn.disabled = true;

  try {
    if (modalType === "call_confirm") {
      await orderApi.changeStatus(orderId, {
        action: "CALL_CONFIRM",
        callResult: form.callResult.value,
        note: note,
        expectedVersion: order.version
      });
    } else if (modalType === "confirm_cod") {
      await orderApi.changeStatus(orderId, {
        status: ORDER_STATES.CONFIRMED,
        reason: note,
        expectedVersion: order.version
      });
    } else if (modalType === "start_processing") {
      await orderApi.changeStatus(orderId, {
        status: ORDER_STATES.PROCESSING,
        reason: note,
        expectedVersion: order.version
      });
    } else if (modalType === "record_shortage") {
      await orderApi.changeStatus(orderId, {
        action: "RECORD_SHORTAGE",
        shortageDetails: form.shortageDetails?.value,
        note: note,
        expectedVersion: order.version
      });
    } else if (modalType === "update_shipping_code") {
      await orderApi.changeStatus(orderId, {
        action: "UPDATE_TRACKING_CODE",
        trackingCode: form.trackingCode.value,
        reason: note,
        expectedVersion: order.version
      });
    } else if (modalType === "handover_shipping") {
      await orderApi.changeStatus(orderId, {
        status: ORDER_STATES.SHIPPING,
        trackingCode: order.tracking_code,
        isHandedOver: true,
        reason: note,
        expectedVersion: order.version
      });
    } else if (modalType === "note_carrier") {
      await orderApi.changeStatus(orderId, {
        action: "NOTE_CARRIER",
        carrierNote: form.carrierContent?.value,
        note: note,
        expectedVersion: order.version
      });
    } else if (modalType === "update_tracking") {
      await orderApi.changeStatus(orderId, {
        action: "UPDATE_TRACKING_INFO",
        trackingInfo: form.trackingInfo?.value,
        note: note,
        expectedVersion: order.version
      });
    } else if (modalType === "cancel_order") {
      await orderApi.cancel(orderId, {
        reason: form.cancelReason?.value || "CUSTOMER_REQUEST",
        note: note,
        expectedVersion: order.version
      });
    }

    overlay.innerHTML = "";
    showToast("Thao tác đã được ghi nhận thành công.");

    await loadOrders();
    if (state.selected && state.selected.order_id === orderId) {
      await openDetail(orderId);
    }
  } catch (error) {
    if (error.code?.includes("VERSION") || error.status === 409) {
      showToast("Dữ liệu đơn hàng đã thay đổi ở nơi khác. Đang làm mới dữ liệu...", true);
      await loadOrders();
      if (state.selected && state.selected.order_id === orderId) {
        await openDetail(orderId);
      }
    } else {
      showToast(error.message || "Không thể thực hiện thao tác", true);
    }
  } finally {
    submitBtn.disabled = false;
  }
}

async function renderLogs() {
  if (!state.logs || state.logs.length === 0) {
    const targets = state.orders.slice(0, 20);
    panel.innerHTML = `<div class="admin-order-empty"><strong>Đang tải nhật ký hệ thống...</strong></div>`;
    try {
      const results = await Promise.all(targets.map((order) => orderApi.auditLogs(order.order_id, { limit: 20 })));
      state.logs = results.flatMap((result) => result.rows || []).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    } catch (error) {
      panel.innerHTML = `<div class="admin-order-empty"><strong>Không thể tải nhật ký</strong><span>${escapeHtml(error.message)}</span></div>`;
      return;
    }
  }

  const totalItems = state.logs.length;
  const totalPages = Math.ceil(totalItems / state.itemsPerPage) || 1;
  if (state.logsPage > totalPages) state.logsPage = totalPages;
  if (state.logsPage < 1) state.logsPage = 1;

  const start = (state.logsPage - 1) * state.itemsPerPage;
  const end = start + state.itemsPerPage;
  const pagedLogs = state.logs.slice(start, end);

  let paginationButtons = "";
  if (totalPages > 1) {
    paginationButtons += `<button type="button" data-order-logs-page="${state.logsPage - 1}" ${state.logsPage === 1 ? "disabled" : ""}>←</button>`;
    for (let i = 1; i <= totalPages; i++) {
      paginationButtons += `<button type="button" class="${state.logsPage === i ? "is-active" : ""}" data-order-logs-page="${i}">${i}</button>`;
    }
    paginationButtons += `<button type="button" data-order-logs-page="${state.logsPage + 1}" ${state.logsPage === totalPages ? "disabled" : ""}>→</button>`;
  }
  const paginationHtml = totalPages > 1 ? `<nav class="admin-pagination">${paginationButtons}</nav>` : "";

  const tableRows =
    pagedLogs
      .map((log) => {
        return `<tr>
      <td>${escapeHtml(dateTime(log.timestamp))}</td>
      <td><span class="admin-order-code">${escapeHtml(log.target_id)}</span></td>
      <td>${escapeHtml(log.actor_role || "Order Admin")}</td>
      <td>${escapeHtml(log.action)}</td>
      <td>${escapeHtml(JSON.stringify(log.new_value || {}))}</td>
    </tr>`;
      })
      .join("") || `<tr><td colspan="5">Chưa có nhật ký</td></tr>`;

  panel.innerHTML = `
    <div class="admin-table-wrap">
      <table class="admin-table admin-data-table">
        <thead>
          <tr>
            <th>Thời gian</th>
            <th>Mã đơn</th>
            <th>Vai trò</th>
            <th>Hành động</th>
            <th>Thay đổi</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>
    <div class="admin-card__footer" style="display:flex; justify-content:space-between; align-items:center; width:100%;">
      <p class="admin-table-note">Hiển thị ${totalItems === 0 ? 0 : start + 1} - ${Math.min(end, totalItems)} / ${totalItems} nhật ký</p>
      ${paginationHtml}
    </div>
  `;
}

function exportCsv() {
  const rows = [
    ["order_id", "order_date", "status", "shipping_name", "shipping_phone", "total_amount"],
    ...filteredOrders().map((o) => [o.order_id, o.order_date, o.status, o.shipping_name, o.shipping_phone, o.total_amount])
  ];
  const csv = rows.map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  link.download = `velura-orders-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function showToast(message, isError = false) {
  const toast = document.querySelector("#order-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}

document.addEventListener("click", (event) => {
  const menuBtn = event.target.closest("[data-order-menu]");
  const menuContent = event.target.closest(".admin-order-action-menu");
  if (!menuBtn && !menuContent) {
    document.querySelectorAll(".admin-order-action-menu").forEach((menu) => {
      menu.hidden = true;
    });
  }

  const logsPageBtn = event.target.closest("[data-order-logs-page]");
  if (logsPageBtn) {
    const page = Number(logsPageBtn.dataset.orderLogsPage);
    if (!Number.isNaN(page) && page > 0) {
      state.logsPage = page;
      renderLogs();
    }
    return;
  }

  const pageBtn = event.target.closest("[data-order-page]");
  if (pageBtn) {
    const page = Number(pageBtn.dataset.orderPage);
    if (!Number.isNaN(page) && page > 0) {
      state.currentPage = page;
      render();
    }
    return;
  }

  const button = event.target.closest("button");
  if (!button) return;

  if (button.dataset.orderTab) {
    state.active = button.dataset.orderTab;
    state.currentPage = 1;
    state.logsPage = 1;
    document.querySelectorAll("[data-order-tab]").forEach((tab) => tab.classList.toggle("admin-tab--active", tab === button));
    render();
  }

  if (button.dataset.orderOpenLogs !== undefined) {
    state.active = "logs";
    state.currentPage = 1;
    state.logsPage = 1;
    const logsTab = document.querySelector('[data-order-tab="logs"]');
    if (logsTab) {
      document.querySelectorAll("[data-order-tab]").forEach((tab) => tab.classList.toggle("admin-tab--active", tab === logsTab));
    }
    render();
  }

  if (button.dataset.orderSidebar !== undefined) document.querySelector(".admin-layout").classList.toggle("admin-layout--sidebar-collapsed");

  if (button.dataset.orderMenu) {
    const targetMenu = document.querySelector(`#order-menu-${CSS.escape(button.dataset.orderMenu)}`);
    if (targetMenu) {
      const isCurrentlyHidden = targetMenu.hidden;
      document.querySelectorAll(".admin-order-action-menu").forEach((menu) => {
        menu.hidden = true;
      });
      targetMenu.hidden = !isCurrentlyHidden;
    }
  }

  if (button.dataset.orderDetail) openDetail(button.dataset.orderDetail);

  if (button.dataset.orderModalType) {
    openActionModal(button.dataset.orderModalType, button.dataset.orderId);
  }

  if (button.dataset.orderClose !== undefined) overlay.innerHTML = "";
  if (button.dataset.orderRetry !== undefined) loadOrders();
  if (button.dataset.orderExport !== undefined) exportCsv();
});

panel.addEventListener("submit", (event) => {
  if (!event.target.matches("[data-order-filter]")) return;
  event.preventDefault();
  state.currentPage = 1;
  const data = new FormData(event.target);
  loadOrders(Object.fromEntries(data.entries()));
});

panel.addEventListener("reset", () => {
  state.currentPage = 1;
  setTimeout(() => loadOrders(), 0);
});

overlay.addEventListener("submit", (event) => {
  if (!event.target.matches("[data-order-action-modal-form]")) return;
  event.preventDefault();
  submitActionModal(event.target);
});

// Start initialization
loadOrders();
