/**
 * Module A4 — Quản lý Khuyến mãi (Admin)
 *
 * QUAN TRỌNG (theo đặc tả UAT):
 *  - lifecycle_status ĐỌC TỪ API, không tự tính từ is_active/ngày tháng (mục 4 spec).
 *  - budget_limit = 0 → "Không giới hạn" (BR-A4-03). Thanh ngân sách chỉ hiện khi có trần VÀ đã phát ≥1 mã (BR-A4-04).
 *  - Nút action chỉ hiện theo lifecycle_status hợp lệ: ended/scheduled/budget_exhausted KHÔNG có nút.
 *  - Mọi write gửi kèm expectedVersion; version conflict → thông báo + refetch.
 *  - FE KHÔNG tự tính số tiền giảm — chỉ hiển thị số liệu từ API.
 */

import { pricingApi } from "./pricing-api.js";
import { productApi } from "./product-api.js";

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  view: "campaigns",
  loading: false,
  error: null,
  promotions: [],
  vouchers: [],
  bundles: [],
  logs: [],
  stats: null,
  // Pagination
  campaignPage: 1,
  voucherPage: 1,
  comboPage: 1,
  logsPage: 1,
  itemsPerPage: 10,
  comboPerPage: 10,
  // Filters
  campaignSearch: "",
  campaignLifecycleFilter: "",
  campaignTypeFilter: "",
  voucherSearch: "",
  voucherStatusFilter: "",
  voucherDiscountTypeFilter: "",
  voucherPromoFilter: "",
  // Other
  comboItems: {},
  allProducts: [],
  categories: [],
};

const panel  = document.querySelector("#promo-panel");
const overlay = document.querySelector("#promo-overlay");
const toast   = document.querySelector("#promo-toast");

// ─── UTILITIES ────────────────────────────────────────────────────────────────
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]);
}
const esc = escapeHtml; // shorthand

function icon(name) {
  return `<svg class="admin-line-icon"><use href="../../assets/icons/admin-icons.svg#${esc(name)}"></use></svg>`;
}
function money(value) {
  return Number(value || 0).toLocaleString("vi-VN") + "đ";
}
function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  return isNaN(d) ? "-" : new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }).format(d);
}
function fmtDatetime(value) {
  if (!value) return "-";
  const d = new Date(value);
  return isNaN(d) ? "-" : new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh"
  }).format(d);
}

// ─── LIFECYCLE STATUS (đọc từ API — không tự suy luận) ──────────────────────
/**
 * lifecycle_status từ API: "running" | "paused" | "scheduled" | "ended" | "budget_exhausted"
 * Fallback nếu API chưa trả (compatibility): suy từ is_active + ngày.
 * Nhưng luôn ưu tiên field API nếu có.
 */
function getLifecycleStatus(row) {
  if (row.lifecycle_status) return row.lifecycle_status;
  // Fallback (không khuyến khích — chỉ dùng khi API cũ chưa trả lifecycle_status)
  const now = Date.now();
  const start = row.start_date ? new Date(row.start_date).getTime() : 0;
  const end   = row.end_date   ? new Date(row.end_date).getTime()   : Infinity;
  if (now > end) return "ended";
  const bl = Number(row.budget_limit || 0);
  const bu = Number(row.total_discount_issued || 0);
  if (bl > 0 && bu >= bl) return "budget_exhausted";
  if (!row.is_active || row.paused_at) return "paused";
  if (now < start) return "scheduled";
  return "running";
}

const LIFECYCLE_META = {
  running:          { label: "Đang chạy",      cls: "admin-badge--success",  icon: "▶" },
  paused:           { label: "Tạm dừng",        cls: "admin-badge--warning",  icon: "⏸" },
  scheduled:        { label: "Chờ tới ngày",    cls: "admin-badge--neutral",  icon: "🕐" },
  ended:            { label: "Đã kết thúc",     cls: "admin-badge--neutral",  icon: "✓"  },
  budget_exhausted: { label: "Hết ngân sách",   cls: "admin-badge--danger",   icon: "⛔" },
};

function lifecycleBadge(row) {
  const status = getLifecycleStatus(row);
  const meta = LIFECYCLE_META[status] || { label: status, cls: "admin-badge--neutral", icon: "" };
  return `<span class="admin-badge ${meta.cls}" title="${meta.label}">${meta.icon} ${meta.label}</span>`;
}

/** Chỉ hiện nút action theo lifecycle hợp lệ (spec mục 4) */
function lifecycleActions(row) {
  const status = getLifecycleStatus(row);
  const id = esc(row.promo_id);
  const btns = [];
  // Chi tiết luôn hiện
  btns.push(`<button class="admin-icon-button admin-icon-button--sm" data-promo-detail="promotion:${id}" title="Chi tiết">${icon("eye")}</button>`);
  // Sửa: chỉ hiện khi chưa ended
  if (status !== "ended") {
    btns.push(`<button class="admin-icon-button admin-icon-button--sm" data-promo-edit="promotion:${id}" title="Chỉnh sửa">${icon("edit")}</button>`);
  }
  // Nút Nhân đôi (Duplicate) chiến dịch
  btns.push(`<button class="admin-icon-button admin-icon-button--sm" data-promo-duplicate="${id}" title="Nhân đôi chiến dịch">${icon("copy")}</button>`);
  // Toggle: running → pause, paused → activate. Không hiện cho ended/scheduled/budget_exhausted
  if (status === "running") {
    btns.push(`<button class="admin-icon-button admin-icon-button--sm admin-icon-button--warn" data-promo-pause="${id}" title="Tạm dừng chiến dịch">${icon("pause")}</button>`);
  } else if (status === "paused") {
    btns.push(`<button class="admin-icon-button admin-icon-button--sm admin-icon-button--ok" data-promo-activate="${id}" title="Kích hoạt chiến dịch">${icon("play")}</button>`);
  }
  // budget_exhausted: không cho kích hoạt lại — phải nâng trần trước (chỉ hiện nút sửa)
  return `<div class="admin-table-actions">${btns.join("")}</div>`;
}

// ─── CAMPAIGN WARNINGS (7 loại cảnh báo vận hành) ────────────────────────────
function getCampaignWarnings(row) {
  const warnings = [];
  const status = getLifecycleStatus(row);
  const bl = Number(row.budget_limit || 0);
  const bu = Number(row.total_discount_issued || 0);
  const linkedVouchers = state.vouchers.filter(v => v.promo_id === row.promo_id);
  const activeVouchers = linkedVouchers.filter(v => v.is_active);

  // BUDGET_EXHAUSTED
  if (status === "budget_exhausted" || (bl > 0 && bu >= bl)) {
    warnings.push({ code: "BUDGET_EXHAUSTED", level: "danger", text: "Đã dùng hết ngân sách" });
  }
  // BUDGET_NEARLY_EXHAUSTED (≥80% và chưa exhausted)
  else if (bl > 0 && bu > 0 && bu / bl >= 0.8) {
    warnings.push({ code: "BUDGET_NEARLY_EXHAUSTED", level: "warning", text: `Sắp cạn ngân sách (${Math.round(bu / bl * 100)}%)` });
  }
  // BUDGET_NOT_TRACKED: có trần nhưng chưa phát mã nào
  if (bl > 0 && bu === 0 && linkedVouchers.length > 0) {
    warnings.push({ code: "BUDGET_NOT_TRACKED", level: "warning", text: "Có trần ngân sách nhưng chưa phát mã nào" });
  }
  // NO_ACTIVE_VOUCHER: đang chạy nhưng không mã nào còn hiệu lực
  if (status === "running" && linkedVouchers.length > 0 && activeVouchers.length === 0) {
    warnings.push({ code: "NO_ACTIVE_VOUCHER", level: "danger", text: "Đang chạy nhưng không có mã hiệu lực" });
  }
  // ENDING_SOON: còn ≤3 ngày
  if (status === "running" && row.end_date) {
    const daysLeft = (new Date(row.end_date) - Date.now()) / 86400000;
    if (daysLeft >= 0 && daysLeft <= 3) {
      warnings.push({ code: "ENDING_SOON", level: "warning", text: `Còn ${Math.ceil(daysLeft)} ngày kết thúc` });
    }
  }
  // PAUSED
  if (status === "paused") {
    warnings.push({ code: "PAUSED", level: "info", text: "Đang tạm dừng thủ công" });
  }
  // OVERLAPPING_CAMPAIGN: từ API nếu có (chỉ hiển thị, không tự xử lý GA-A4-03)
  if (row.alerts && row.alerts.includes("OVERLAPPING_CAMPAIGN")) {
    warnings.push({ code: "OVERLAPPING_CAMPAIGN", level: "warning", text: "Có chiến dịch khác chồng lấn thời gian" });
  }
  return warnings;
}

function warningChips(warnings) {
  if (!warnings.length) return "";
  return `<div class="promo-warning-chips">${warnings.map(w =>
    `<span class="promo-chip promo-chip--${w.level}" title="${esc(w.code)}">${esc(w.text)}</span>`
  ).join("")}</div>`;
}

// ─── BUDGET DISPLAY (BR-A4-03, BR-A4-04) ─────────────────────────────────────
function budgetDisplay(row, linkedVouchers) {
  const bl = Number(row.budget_limit || 0);
  const bu = Number(row.total_discount_issued || 0);

  // BR-A4-03: budget_limit = 0 → Không giới hạn
  if (bl === 0) {
    const activeV = linkedVouchers.filter(v => v.is_active).length;
    return `<span class="promo-budget-unlimited">Không giới hạn</span>
            <small style="color:var(--muted)">${activeV} / ${linkedVouchers.length} mã hiệu lực</small>`;
  }
  // BR-A4-04: chỉ hiện thanh khi có trần VÀ đã phát ≥1 mã
  if (bu === 0) {
    // Có trần nhưng chưa phát mã — dùng chỉ số thay thế: số mã
    const activeV = linkedVouchers.filter(v => v.is_active).length;
    return `<span style="font-size:0.8125rem">${money(bl)} <span style="color:var(--muted)">(chưa theo dõi)</span></span>
            <small style="color:var(--muted)">${activeV} / ${linkedVouchers.length} mã hiệu lực</small>`;
  }
  // Có trần + đã phát → thanh tiến độ màu theo mức
  const pct = Math.min(Math.round(bu * 100 / bl), 100);
  const color = pct >= 100 ? "var(--error,#e74c3c)" : pct >= 80 ? "var(--warning,#e67e22)" : "var(--terracotta)";
  return `<div style="font-size:0.8125rem">${money(bu)} / ${money(bl)}</div>
          <div class="admin-progress admin-progress--wide" style="margin-top:4px">
            <span style="width:${pct}%;background:${color}"></span>
          </div>
          <small class="admin-order-subtext">${pct}% đã sử dụng</small>`;
}

// ─── TYPE LABELS ──────────────────────────────────────────────────────────────
function promoTypeLabel(type) {
  const map = {
    flash_sale: "Flash Sale",
    combo_discount: "Giảm Combo",
    product_discount: "Giảm SP",
    bulk_discount: "Giảm sỉ",
    seasonal_sale: "Theo mùa",
  };
  return map[type] || type || "-";
}
function discountTypeLabel(type) {
  return type === "percentage" ? "Theo phần trăm"
    : type === "fixed_amount" ? "Số tiền cố định"
    : type === "free_shipping" ? "Miễn phí vận chuyển"
    : type || "-";
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
function showToast(message, type = "success") {
  if (!toast) return;
  toast.textContent = message;
  toast.className = `admin-toast admin-toast--${type}`;
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, 3500);
}

// ─── PAGINATION ───────────────────────────────────────────────────────────────
function renderPagination(total, page, perPage, attr) {
  const pages = Math.ceil(total / perPage) || 1;
  if (pages <= 1) return "";
  let html = `<nav class="admin-pagination">`;
  html += `<button type="button" data-${attr}="${page - 1}" ${page === 1 ? "disabled" : ""}>←</button>`;
  for (let i = 1; i <= pages; i++) {
    if (pages > 7 && i !== 1 && i !== pages && Math.abs(page - i) > 1) {
      if (i === 2 && page > 3) html += `<span style="padding:0 4px;color:var(--muted)">…</span>`;
      else if (i === pages - 1 && page < pages - 2) html += `<span style="padding:0 4px;color:var(--muted)">…</span>`;
      continue;
    }
    html += `<button type="button" class="${page === i ? "is-active" : ""}" data-${attr}="${i}">${i}</button>`;
  }
  html += `<button type="button" data-${attr}="${page + 1}" ${page === pages ? "disabled" : ""}>→</button>`;
  return html + "</nav>";
}

// ─── KPIs ─────────────────────────────────────────────────────────────────────
function updateKpis() {
  const running = state.promotions.filter(r => getLifecycleStatus(r) === "running").length;
  const activeV = state.vouchers.filter(v => v.is_active).length;
  const issued  = state.promotions.reduce((s, r) => s + Number(r.total_discount_issued || 0), 0);
  const budget  = state.promotions.reduce((s, r) => s + Number(r.budget_limit || 0), 0);
  const alerts  = state.promotions.filter(r => getCampaignWarnings(r).some(w => w.level === "danger")).length;

  const kpiEl = document.querySelector("#promo-kpis");
  if (!kpiEl) return;
  const kpis = [
    ["Đang chạy",        String(running),   "tag"],
    ["Voucher hoạt động", String(activeV),  "tag"],
    ["Đã phát hành",     money(issued),     "tag"],
    ["Tổng ngân sách",   budget > 0 ? money(budget) : "Không giới hạn", "tag"],
    ["Cần chú ý",        String(alerts),    "alert"],
  ];
  kpiEl.innerHTML = kpis.map(([label, value, ico]) =>
    `<article class="admin-kpi-card"><div class="admin-kpi-card__head">
      <p class="admin-kpi-card__label">${label}</p>
      <span class="admin-kpi-card__icon">${icon(ico)}</span>
     </div><strong class="admin-kpi-card__value">${value}</strong></article>`
  ).join("");

  // Tab counts
  document.querySelectorAll("[data-promo-view] span").forEach(node => {
    const v = node.parentElement.dataset.promoView;
    node.textContent = v === "campaigns" ? state.promotions.length
      : v === "vouchers" ? state.vouchers.length
      : v === "bundles"  ? state.bundles.length
      : v === "stats"    ? "" : state.logs.length;
  });
}

// ─── CAMPAIGNS VIEW ───────────────────────────────────────────────────────────
function getFilteredCampaigns() {
  return state.promotions.filter(row => {
    const q = state.campaignSearch.toLowerCase();
    if (q && !JSON.stringify(row).toLowerCase().includes(q)) return false;
    if (state.campaignLifecycleFilter && getLifecycleStatus(row) !== state.campaignLifecycleFilter) return false;
    if (state.campaignTypeFilter && row.promo_type !== state.campaignTypeFilter) return false;
    return true;
  });
}

function campaignFilterBar() {
  return `<div class="admin-filter-bar" id="campaign-filter-bar">
    <label class="admin-search-field">
      ${icon("search")}
      <input class="admin-form-control" type="search" id="campaign-search"
        placeholder="Tên chiến dịch, mã ID…" value="${esc(state.campaignSearch)}">
    </label>
    <select class="admin-form-control" id="campaign-lifecycle-filter">
      <option value="" ${!state.campaignLifecycleFilter ? "selected" : ""}>Tất cả trạng thái</option>
      <option value="running"          ${state.campaignLifecycleFilter==="running"          ? "selected":""}> ▶ Đang chạy</option>
      <option value="paused"           ${state.campaignLifecycleFilter==="paused"           ? "selected":""}> ⏸ Tạm dừng</option>
      <option value="scheduled"        ${state.campaignLifecycleFilter==="scheduled"        ? "selected":""}> 🕐 Chờ tới ngày</option>
      <option value="ended"            ${state.campaignLifecycleFilter==="ended"            ? "selected":""}> ✓ Đã kết thúc</option>
      <option value="budget_exhausted" ${state.campaignLifecycleFilter==="budget_exhausted" ? "selected":""}> ⛔ Hết ngân sách</option>
    </select>
    <select class="admin-form-control" id="campaign-type-filter">
      <option value="" ${!state.campaignTypeFilter ? "selected" : ""}>Tất cả loại</option>
      <option value="product_discount" ${state.campaignTypeFilter==="product_discount" ? "selected":""}>Giảm giá sản phẩm</option>
      <option value="combo_discount"   ${state.campaignTypeFilter==="combo_discount"   ? "selected":""}>Giảm giá Combo</option>
      <option value="flash_sale"       ${state.campaignTypeFilter==="flash_sale"       ? "selected":""}>Flash Sale</option>
      <option value="seasonal_sale"    ${state.campaignTypeFilter==="seasonal_sale"    ? "selected":""}>Theo mùa</option>
      <option value="bulk_discount"    ${state.campaignTypeFilter==="bulk_discount"    ? "selected":""}>Giảm sỉ</option>
    </select>
    <div class="admin-filter-bar__actions">
      <button class="admin-btn admin-btn--ghost admin-btn--sm" type="button" id="btn-reset-campaigns">Đặt lại</button>
    </div>
  </div>`;
}

function renderCampaigns() {
  const filtered = getFilteredCampaigns();
  const total  = filtered.length;
  const start  = (state.campaignPage - 1) * state.itemsPerPage;
  const paged  = filtered.slice(start, start + state.itemsPerPage);

  let rowsHtml = "";
  if (!paged.length) {
    rowsHtml = `<tr><td colspan="7">${emptyState(
      state.campaignSearch || state.campaignLifecycleFilter || state.campaignTypeFilter
        ? "Không có chiến dịch phù hợp với bộ lọc"
        : "Chưa có chiến dịch nào. Bấm \"Tạo chiến dịch\" để bắt đầu."
    )}</td></tr>`;
  } else {
    rowsHtml = paged.map(row => {
      const linkedVouchers = state.vouchers.filter(v => v.promo_id === row.promo_id);
      const warnings = getCampaignWarnings(row);
      return `<tr>
        <td>
          <strong>${esc(row.promo_name)}</strong>
          <small class="admin-order-subtext">${esc(row.promo_id)}</small>
          ${warningChips(warnings)}
        </td>
        <td><span class="admin-badge admin-badge--neutral promo-type-badge">${esc(promoTypeLabel(row.promo_type))}</span></td>
        <td style="font-size:0.8125rem;white-space:nowrap">
          ${fmtDate(row.start_date)}<br>
          <span style="color:var(--muted)">→ ${fmtDate(row.end_date)}</span>
        </td>
        <td style="min-width:160px">${budgetDisplay(row, linkedVouchers)}</td>
        <td style="font-size:0.8125rem;color:var(--muted)">${linkedVouchers.length} mã</td>
        <td>${lifecycleBadge(row)}</td>
        <td>${lifecycleActions(row)}</td>
      </tr>`;
    }).join("");
  }

  const footer = `<div class="admin-card__footer">
    <p class="admin-table-note">Hiển thị ${total===0?0:start+1}–${Math.min(start+state.itemsPerPage,total)} / ${total} chiến dịch</p>
    ${renderPagination(total, state.campaignPage, state.itemsPerPage, "campaign-page")}
  </div>`;

  panel.innerHTML = campaignFilterBar()
    + tableWrap(["Chiến dịch", "Loại", "Thời gian", "Ngân sách", "Mã", "Trạng thái", "Thao tác"],
        rowsHtml, footer);
  bindFilterEvents();
}

// ─── VOUCHERS VIEW ────────────────────────────────────────────────────────────
function getFilteredVouchers() {
  return state.vouchers.filter(row => {
    const promo = row.promo_id ? state.promotions.find(p => p.promo_id === row.promo_id) : null;
    const isPromoActive = promo ? promo.is_active : true;
    const isActive = row.is_active && isPromoActive;
    const q = state.voucherSearch.toLowerCase();
    if (q && !JSON.stringify(row).toLowerCase().includes(q)) return false;
    if (state.voucherStatusFilter === "active" && !isActive) return false;
    if (state.voucherStatusFilter === "paused" && isActive) return false;
    if (state.voucherDiscountTypeFilter && row.discount_type !== state.voucherDiscountTypeFilter) return false;
    if (state.voucherPromoFilter && row.promo_id !== state.voucherPromoFilter) return false;
    return true;
  });
}

function voucherFilterBar() {
  const promoOptions = state.promotions.map(p =>
    `<option value="${esc(p.promo_id)}" ${state.voucherPromoFilter===p.promo_id ? "selected":""}>${esc(p.promo_name)}</option>`
  ).join("");

  return `<div class="admin-filter-bar" id="voucher-filter-bar">
    <label class="admin-search-field">
      ${icon("search")}
      <input class="admin-form-control" type="search" id="voucher-search"
        placeholder="Mã code, tên voucher…" value="${esc(state.voucherSearch)}">
    </label>
    <select class="admin-form-control" id="voucher-status-filter">
      <option value="" ${!state.voucherStatusFilter ? "selected":""}>Tất cả trạng thái</option>
      <option value="active" ${state.voucherStatusFilter==="active" ? "selected":""}>Đang hoạt động</option>
      <option value="paused" ${state.voucherStatusFilter==="paused" ? "selected":""}>Tạm dừng</option>
    </select>
    <select class="admin-form-control" id="voucher-type-filter">
      <option value="" ${!state.voucherDiscountTypeFilter ? "selected":""}>Tất cả loại giảm</option>
      <option value="percentage" ${state.voucherDiscountTypeFilter==="percentage" ? "selected":""}>Theo phần trăm (%)</option>
      <option value="fixed_amount" ${state.voucherDiscountTypeFilter==="fixed_amount" ? "selected":""}>Số tiền cố định (đ)</option>
      <option value="free_shipping" ${state.voucherDiscountTypeFilter==="free_shipping" ? "selected":""}>Miễn phí vận chuyển</option>
    </select>
    <select class="admin-form-control" id="voucher-promo-filter">
      <option value="" ${!state.voucherPromoFilter ? "selected":""}>Tất cả chiến dịch</option>
      ${promoOptions}
    </select>
    <div class="admin-filter-bar__actions">
      <button class="admin-btn admin-btn--ghost admin-btn--sm" type="button" id="btn-reset-vouchers">Đặt lại</button>
    </div>
  </div>`;
}

function renderVouchers() {
  const filtered = getFilteredVouchers();
  const total = filtered.length;
  const start = (state.voucherPage - 1) * state.itemsPerPage;
  const paged = filtered.slice(start, start + state.itemsPerPage);

  let rowsHtml = "";
  if (!paged.length) {
    rowsHtml = `<tr><td colspan="8">${emptyState("Không có voucher phù hợp")}</td></tr>`;
  } else {
    rowsHtml = paged.map(row => {
      const promo = row.promo_id ? state.promotions.find(p => p.promo_id === row.promo_id) : null;
      const isPromoActive = promo ? promo.is_active : true;
      const isActive = row.is_active && isPromoActive;
      const statusBadge = isActive
        ? `<span class="admin-badge admin-badge--success">Hoạt động</span>`
        : `<span class="admin-badge admin-badge--warning">${!row.is_active ? "Tạm dừng" : "Dừng (CĐ)"}</span>`;

      // BR-A4-01: mã chỉ dùng được khi cả mã lẫn chiến dịch cha đều hợp lệ
      const br01Warning = row.is_active && !isPromoActive
        ? `<small class="promo-chip promo-chip--warning" title="BR-A4-01">Chiến dịch cha đang dừng</small>` : "";

      return `<tr>
        <td>
          <strong>${esc(row.code)}</strong>
          <small class="admin-order-subtext">${esc(row.name)}</small>
          ${br01Warning}
        </td>
        <td style="font-size:0.8125rem">${esc(discountTypeLabel(row.discount_type))}</td>
        <td><strong>${row.discount_type === "percentage" ? row.discount_value + "%" : money(row.discount_value)}</strong></td>
        <td style="font-size:0.8125rem">${money(row.min_order_value)}</td>
        <td><strong>${esc(String(row.used_count || 0))}</strong> / ${esc(String(row.usage_limit_total || "∞"))}</td>
        <td style="font-size:0.8125rem;white-space:nowrap">${fmtDate(row.end_date)}</td>
        <td>${statusBadge}</td>
        <td><div class="admin-table-actions">
          <button class="admin-icon-button admin-icon-button--sm" data-promo-detail="voucher:${esc(row.voucher_id)}" title="Chi tiết">${icon("eye")}</button>
          <button class="admin-icon-button admin-icon-button--sm" data-voucher-edit="${esc(row.voucher_id)}" title="Chỉnh sửa">${icon("edit")}</button>
          <button class="admin-icon-button admin-icon-button--sm" data-voucher-toggle="${esc(row.voucher_id)}" title="${row.is_active ? "Tạm dừng" : "Kích hoạt"}">${icon("refresh")}</button>
        </div></td>
      </tr>`;
    }).join("");
  }

  const footer = `<div class="admin-card__footer">
    <p class="admin-table-note">Hiển thị ${total===0?0:start+1}–${Math.min(start+state.itemsPerPage,total)} / ${total} voucher</p>
    ${renderPagination(total, state.voucherPage, state.itemsPerPage, "voucher-page")}
  </div>`;

  panel.innerHTML = voucherFilterBar()
    + tableWrap(["Mã", "Loại", "Giá trị", "Đơn tối thiểu", "Lượt dùng", "Hết hạn", "Trạng thái", "Thao tác"],
        rowsHtml, footer);
  bindFilterEvents();
}

// ─── BUNDLES VIEW ─────────────────────────────────────────────────────────────
function renderBundles() {
  // GA-A4-02: 2 bảng riêng — chiến dịch combo_discount vs sản phẩm is_combo
  const comboCampaigns = state.promotions.filter(r => r.promo_type === "combo_discount");
  const total = state.bundles.length;
  const start = (state.comboPage - 1) * state.comboPerPage;
  const paged = state.bundles.slice(start, start + state.comboPerPage);

  // Bảng 1: Sản phẩm Combo (is_combo)
  const comboProductRows = paged.map(row => {
    const comboItems = (state.comboItems || {})[row.product_id] || [];
    const itemCount  = comboItems.length;
    const saving     = itemCount > 0 ? calcComboSaving(row, comboItems) : null;
    const savingHtml = saving && saving > 0 ? `<small style="color:var(--success)">-${Math.round(saving)}%</small>` : "";
    const statusBadge = row.status === "on_sale"
      ? `<span class="admin-badge admin-badge--success">Bán</span>`
      : `<span class="admin-badge admin-badge--warning">Ẩn</span>`;
    return `<tr>
      <td><strong>${esc(row.name)}</strong><small class="admin-order-subtext">${esc(row.sku)}</small></td>
      <td>${money(row.base_price)}</td>
      <td>${money(row.sale_price ?? row.base_price)}${savingHtml}</td>
      <td>${itemCount} sản phẩm</td>
      <td>${statusBadge}</td>
      <td><div class="admin-table-actions">
        <button class="admin-icon-button admin-icon-button--sm" data-promo-detail="bundle:${esc(row.product_id)}" title="Quản lý thành phần">${icon("edit")}</button>
      </div></td>
    </tr>`;
  }).join("") || `<tr><td colspan="6">${emptyState("Chưa có sản phẩm combo. Nhấn \"Tạo Combo mới\".")}</td></tr>`;

  const footer = `<div class="admin-card__footer">
    <p class="admin-table-note">Hiển thị ${total===0?0:start+1}–${Math.min(start+state.comboPerPage,total)} / ${total} combo</p>
    ${renderPagination(total, state.comboPage, state.comboPerPage, "combo-page")}
  </div>`;

  // Bảng 2: Chiến dịch loại combo_discount (GA-A4-02 — chưa liên kết với bảng is_combo)
  const comboCampaignRows = comboCampaigns.map(row => {
    const warnings = getCampaignWarnings(row);
    return `<tr>
      <td><strong>${esc(row.promo_name)}</strong><small class="admin-order-subtext">${esc(row.promo_id)}</small>${warningChips(warnings)}</td>
      <td>${fmtDate(row.start_date)} → ${fmtDate(row.end_date)}</td>
      <td>${lifecycleBadge(row)}</td>
      <td><div class="admin-table-actions">
        <button class="admin-icon-button admin-icon-button--sm" data-promo-detail="promotion:${esc(row.promo_id)}" title="Chi tiết">${icon("eye")}</button>
      </div></td>
    </tr>`;
  }).join("") || `<tr><td colspan="4"><div class="admin-order-empty" style="padding:16px;font-size:0.8125rem">Chưa có chiến dịch Giảm giá Combo.</div></td></tr>`;

  panel.innerHTML = `
    <div class="admin-section__header" style="padding:16px 20px 12px;display:flex;align-items:center;justify-content:space-between">
      <h3 style="margin:0;font-size:1.0625rem;font-weight:500">Sản phẩm Combo (cờ is_combo)</h3>
      <button class="admin-btn admin-btn--secondary admin-btn--sm" data-promo-modal="combo">${icon("plus")} Tạo Combo mới</button>
    </div>
    ${tableWrap(["Combo", "Giá gốc", "Giá bán", "Thành phần", "Trạng thái", "Thao tác"], comboProductRows, footer)}

    <div class="admin-section__header" style="padding:20px 20px 12px;display:flex;align-items:center;gap:10px">
      <h3 style="margin:0;font-size:1.0625rem;font-weight:500">Chiến dịch Giảm giá Combo</h3>
      <span class="admin-badge admin-badge--warning" style="font-size:0.75rem" title="GA-A4-02">Chưa liên kết với bảng sản phẩm combo</span>
    </div>
    <div class="admin-note admin-note--warning" style="margin:0 20px 12px;font-size:0.8125rem">
      ⚠️ Hai bảng này chưa được liên kết tự động (GA-A4-02). Liên kết thủ công qua ticket riêng.
    </div>
    ${tableWrap(["Chiến dịch", "Thời gian", "Trạng thái", "Thao tác"], comboCampaignRows, "")}
  `;
}

function calcComboSaving(combo, comboItems) {
  const totalItemValue = comboItems.reduce((sum, item) => {
    const product = (state.allProducts || []).find(p => p.product_id === item.component_product_id);
    return sum + (product ? (product.sale_price ?? product.base_price) * (item.quantity || 1) : 0);
  }, 0);
  const comboPrice = combo.sale_price ?? combo.base_price;
  return totalItemValue > 0 ? ((totalItemValue - comboPrice) / totalItemValue) * 100 : 0;
}

// ─── LOGS VIEW ────────────────────────────────────────────────────────────────
function renderLogs() {
  const total = state.logs.length;
  const start = (state.logsPage - 1) * state.itemsPerPage;
  const paged = state.logs.slice(start, start + state.itemsPerPage);

  let rowsHtml = "";
  if (!paged.length) {
    rowsHtml = `<tr><td colspan="6">${emptyState("Chưa có nhật ký thao tác")}</td></tr>`;
  } else {
    rowsHtml = paged.map(row => {
      const ov = row.old_value || {};
      const nv = row.new_value || {};
      const statusChange = (ov.status || nv.status)
        ? `${esc(ov.status || "—")} → ${esc(nv.status || "—")}` : "—";
      return `<tr>
        <td style="white-space:nowrap">${fmtDatetime(row.timestamp)}</td>
        <td>${esc(row.actor_id || "Hệ thống")}<br><small style="color:var(--muted)">${esc(row.actor_role || "")}</small></td>
        <td>${esc(row.module || "A4")}</td>
        <td><strong>${esc(row.target_id || "—")}</strong></td>
        <td>${esc(row.action || "—")}</td>
        <td>${statusChange}</td>
      </tr>`;
    }).join("");
  }

  const footer = `<div class="admin-card__footer">
    <p class="admin-table-note">Hiển thị ${total===0?0:start+1}–${Math.min(start+state.itemsPerPage,total)} / ${total} nhật ký</p>
    ${renderPagination(total, state.logsPage, state.itemsPerPage, "promo-logs-page")}
  </div>`;

  panel.innerHTML = tableWrap(
    ["Thời gian", "Người thực hiện", "Nhóm", "Đối tượng", "Hành động", "Trạng thái"],
    rowsHtml, footer
  );
}

// ─── STATS VIEW ───────────────────────────────────────────────────────────────
function renderStats() {
  const s = state.stats;
  if (!s) {
    panel.innerHTML = `<div class="admin-order-empty"><strong>Đang tải thống kê…</strong></div>`;
    return;
  }
  const p = s.promotions || {};
  const v = s.vouchers   || {};

  const byType = { percentage: 0, fixed_amount: 0, free_shipping: 0 };
  state.vouchers.forEach(vc => { if (byType.hasOwnProperty(vc.discount_type)) byType[vc.discount_type]++; });
  const totalV = state.vouchers.length || 1;

  const topVouchers = [...state.vouchers]
    .sort((a, b) => (b.used_count || 0) - (a.used_count || 0))
    .slice(0, 5);

  // Lifecycle breakdown
  const lc = { running: 0, paused: 0, scheduled: 0, ended: 0, budget_exhausted: 0 };
  state.promotions.forEach(r => { const s = getLifecycleStatus(r); if (lc[s] !== undefined) lc[s]++; });

  panel.innerHTML = `
    <div class="admin-promo-console">
      <div class="admin-promo-detail-grid" style="grid-template-columns:repeat(5,minmax(0,1fr))">
        ${Object.entries(LIFECYCLE_META).map(([status, meta]) =>
          `<article>
            <span>${meta.icon} ${meta.label}</span>
            <strong class="admin-badge ${meta.cls}" style="font-size:1.25rem;padding:4px 10px;display:inline-block;margin-top:8px">${lc[status] || 0}</strong>
          </article>`
        ).join("")}
      </div>

      <div class="admin-promo-overview-grid">
        <section class="admin-card">
          <div class="admin-card__header"><h3>Ngân sách khuyến mãi</h3></div>
          <div class="admin-card__body">
            <dl class="admin-data-list">
              <div><dt>Tổng ngân sách</dt><dd><b>${money(p.totalBudget)}</b></dd></div>
              <div><dt>Đã phát hành</dt><dd><b>${money(p.totalIssued)}</b></dd></div>
              <div><dt>Còn lại</dt><dd><b>${money(p.budgetRemaining)}</b></dd></div>
              <div><dt>Tỷ lệ sử dụng</dt><dd>${p.budgetUsagePercent || 0}%</dd></div>
            </dl>
            ${p.totalBudget > 0 ? `<div style="margin-top:12px">
              <div class="admin-progress admin-progress--wide">
                <span style="width:${Math.min(p.budgetUsagePercent||0,100)}%;background:${(p.budgetUsagePercent||0)>=80?"var(--error)":"var(--terracotta)"}"></span>
              </div>
              <small class="admin-order-subtext">${p.budgetUsagePercent||0}% đã sử dụng</small>
            </div>` : `<p style="color:var(--muted);font-size:0.8125rem;margin-top:8px">Không có chiến dịch đặt trần ngân sách</p>`}
          </div>
        </section>
        <section class="admin-card">
          <div class="admin-card__header"><h3>Voucher</h3></div>
          <div class="admin-card__body">
            <dl class="admin-data-list">
              <div><dt>Tổng voucher</dt><dd><b>${v.total || state.vouchers.length}</b></dd></div>
              <div><dt>Đang hoạt động</dt><dd><b style="color:var(--success)">${v.active || 0}</b></dd></div>
              <div><dt>Tạm dừng / Hết hạn</dt><dd><b>${v.expired || 0}</b></dd></div>
              <div><dt>Lượt sử dụng</dt><dd>${v.totalUsed || 0} / ${v.totalLimit || "∞"}</dd></div>
            </dl>
            ${(v.totalLimit||0) > 0 ? `<div style="margin-top:12px">
              <div class="admin-progress admin-progress--wide">
                <span style="width:${Math.min(v.usagePercent||0,100)}%;background:var(--terracotta)"></span>
              </div><small class="admin-order-subtext">${v.usagePercent||0}% đã sử dụng</small>
            </div>` : ""}
          </div>
        </section>
      </div>

      <div class="admin-promo-overview-grid">
        <section class="admin-card">
          <div class="admin-card__header"><h3>Phân loại Voucher theo kiểu giảm</h3></div>
          <div class="admin-card__body">
            ${[
              ["Theo phần trăm (%)", byType.percentage, "#c0392b"],
              ["Số tiền cố định (đ)", byType.fixed_amount, "#e67e22"],
              ["Miễn phí vận chuyển", byType.free_shipping, "#16a085"],
            ].map(([label, count, color]) => {
              const pct = Math.round(count / totalV * 100);
              return `<div style="margin-bottom:14px">
                <div style="display:flex;justify-content:space-between;font-size:0.8125rem;margin-bottom:4px">
                  <span>${label}</span><strong>${count} (${pct}%)</strong>
                </div>
                <div class="admin-progress admin-progress--wide"><span style="width:${pct}%;background:${color}"></span></div>
              </div>`;
            }).join("")}
          </div>
        </section>
        <section class="admin-card">
          <div class="admin-card__header"><h3>Top 5 Voucher dùng nhiều nhất</h3></div>
          <div class="admin-card__body">
            ${topVouchers.length ? topVouchers.map((vc, i) => `
              <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
                <span style="font-size:1rem;font-weight:700;color:var(--muted);min-width:22px">#${i+1}</span>
                <div style="flex:1;min-width:0">
                  <strong style="font-size:0.875rem">${esc(vc.code)}</strong>
                  <small style="display:block;color:var(--muted);font-size:0.75rem">${esc(vc.name)}</small>
                </div>
                <span style="font-size:0.875rem;font-weight:600;color:var(--terracotta)">${vc.used_count||0} lượt</span>
              </div>`).join("")
            : `<p style="color:var(--muted);font-size:0.8125rem">Chưa có dữ liệu</p>`}
          </div>
        </section>
      </div>
    </div>`;
}

// ─── SHARED HELPERS ───────────────────────────────────────────────────────────
function tableWrap(headers, rowsHtml, footer) {
  return `<div class="admin-table-wrap">
    <table class="admin-table admin-data-table">
      <thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>${footer || ""}`;
}

function emptyState(message) {
  return `<div class="admin-order-empty" style="padding:32px 16px;text-align:center">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.5" style="margin:0 auto 12px">
      <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
    </svg>
    <strong style="display:block;color:var(--muted)">${esc(message)}</strong>
  </div>`;
}

function errorState(message) {
  return `<div class="admin-order-empty" style="padding:32px 16px;text-align:center;color:var(--error)">
    <strong>⚠️ ${esc(message)}</strong>
    <button class="admin-btn admin-btn--ghost admin-btn--sm" style="display:block;margin:12px auto 0" onclick="location.reload()">Thử lại</button>
  </div>`;
}

// ─── RENDER ROUTER ────────────────────────────────────────────────────────────
function render() {
  if (state.loading) {
    panel.innerHTML = `<div class="admin-order-empty" style="padding:32px">
      <div class="promo-spinner"></div><p style="color:var(--muted);margin-top:12px">Đang tải dữ liệu…</p>
    </div>`;
    return;
  }
  if (state.error) {
    panel.innerHTML = errorState(state.error);
    return;
  }
  switch (state.view) {
    case "campaigns": renderCampaigns(); break;
    case "vouchers":  renderVouchers();  break;
    case "bundles":   renderBundles();   break;
    case "logs":      renderLogs();      break;
    case "stats":     renderStats();     break;
    default: renderCampaigns();
  }
}

// ─── FILTER EVENT BINDING ─────────────────────────────────────────────────────
function bindFilterEvents() {
  // Campaigns
  const cs = document.getElementById("campaign-search");
  if (cs) cs.addEventListener("input", e => { state.campaignSearch = e.target.value; state.campaignPage = 1; render(); });
  const clf = document.getElementById("campaign-lifecycle-filter");
  if (clf) clf.addEventListener("change", e => { state.campaignLifecycleFilter = e.target.value; state.campaignPage = 1; render(); });
  const ctf = document.getElementById("campaign-type-filter");
  if (ctf) ctf.addEventListener("change", e => { state.campaignTypeFilter = e.target.value; state.campaignPage = 1; render(); });
  const brc = document.getElementById("btn-reset-campaigns");
  if (brc) brc.addEventListener("click", () => {
    state.campaignSearch = ""; state.campaignLifecycleFilter = ""; state.campaignTypeFilter = "";
    state.campaignPage = 1; render();
  });

  // Vouchers
  const vs = document.getElementById("voucher-search");
  if (vs) vs.addEventListener("input", e => { state.voucherSearch = e.target.value; state.voucherPage = 1; render(); });
  const vsf = document.getElementById("voucher-status-filter");
  if (vsf) vsf.addEventListener("change", e => { state.voucherStatusFilter = e.target.value; state.voucherPage = 1; render(); });
  const vtf = document.getElementById("voucher-type-filter");
  if (vtf) vtf.addEventListener("change", e => { state.voucherDiscountTypeFilter = e.target.value; state.voucherPage = 1; render(); });
  const vpf = document.getElementById("voucher-promo-filter");
  if (vpf) vpf.addEventListener("change", e => { state.voucherPromoFilter = e.target.value; state.voucherPage = 1; render(); });
  const brv = document.getElementById("btn-reset-vouchers");
  if (brv) brv.addEventListener("click", () => {
    state.voucherSearch = ""; state.voucherStatusFilter = ""; state.voucherDiscountTypeFilter = ""; state.voucherPromoFilter = "";
    state.voucherPage = 1; render();
  });
}

// ─── DETAIL DRAWER ────────────────────────────────────────────────────────────
function openDetail(type, id) {
  const row = type === "promotion" ? state.promotions.find(r => r.promo_id === id)
    : type === "voucher" ? state.vouchers.find(r => r.voucher_id === id)
    : state.bundles.find(r => r.product_id === id);
  if (!row) return;

  let bodyHtml = "";

  if (type === "promotion") {
    const bl = Number(row.budget_limit || 0);
    const bu = Number(row.total_discount_issued || 0);
    const linkedVouchers = state.vouchers.filter(v => v.promo_id === id);
    const warnings = getCampaignWarnings(row);
    const status = getLifecycleStatus(row);

    const warningSection = warnings.length ? `
      <div style="margin-bottom:16px">
        <h3 class="admin-drawer__section">Cảnh báo vận hành</h3>
        <div class="promo-warning-chips" style="flex-direction:column;gap:6px">
          ${warnings.map(w =>
            `<div class="promo-chip promo-chip--${w.level}" style="display:block;padding:8px 12px">
              <strong>[${w.code}]</strong> ${esc(w.text)}
            </div>`
          ).join("")}
        </div>
      </div>` : "";

    bodyHtml = `
      ${warningSection}
      <dl class="admin-data-list">
        <div><dt>Tên chiến dịch</dt><dd><strong>${esc(row.promo_name)}</strong></dd></div>
        <div><dt>Loại</dt><dd>${esc(promoTypeLabel(row.promo_type))}</dd></div>
        <div><dt>Trạng thái vòng đời</dt><dd>${lifecycleBadge(row)}</dd></div>
        <div><dt>Thời gian</dt><dd>${fmtDate(row.start_date)} → ${fmtDate(row.end_date)}</dd></div>
        <div><dt>Ngân sách (trần)</dt><dd>${bl === 0 ? "<strong>Không giới hạn</strong>" : money(bl)}</dd></div>
        <div><dt>Đã phát hành</dt><dd>${money(bu)}</dd></div>
        ${row.description ? `<div><dt>Mô tả</dt><dd>${esc(row.description)}</dd></div>` : ""}
        <div><dt>Phiên bản (version)</dt><dd><code>${esc(row.version)}</code></dd></div>
      </dl>
      ${bl > 0 && bu > 0 ? `<div style="margin:12px 0">${budgetDisplay(row, linkedVouchers)}</div>` : ""}

      <h3 class="admin-drawer__section" style="margin-top:20px">Mã giảm giá liên kết (${linkedVouchers.length})</h3>
      ${linkedVouchers.length ? `
        <table class="admin-table admin-data-table" style="font-size:0.8125rem;margin-top:8px">
          <thead><tr><th>Mã</th><th>Loại giảm</th><th>Giá trị</th><th>Lượt dùng</th><th>Trạng thái</th></tr></thead>
          <tbody>${linkedVouchers.map(v => `
            <tr>
              <td><strong>${esc(v.code)}</strong><br><small style="color:var(--muted)">${esc(v.name)}</small></td>
              <td>${esc(discountTypeLabel(v.discount_type))}</td>
              <td>${v.discount_type==="percentage" ? v.discount_value+"%" : money(v.discount_value)}</td>
              <td>${v.used_count||0} / ${v.usage_limit_total||"∞"}</td>
              <td>${v.is_active && row.is_active
                ? `<span class="admin-badge admin-badge--success">Hoạt động</span>`
                : `<span class="admin-badge admin-badge--warning">${!v.is_active?"Dừng":"Dừng (CĐ)"}</span>`}</td>
            </tr>`).join("")}
          </tbody>
        </table>` :
        `<p style="font-style:italic;color:var(--muted);font-size:0.8125rem">Chưa có mã giảm giá nào.</p>`}

      <div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="admin-btn admin-btn--ghost admin-btn--sm" data-promo-edit="promotion:${esc(id)}">${icon("edit")} Chỉnh sửa</button>
        ${status === "running"
          ? `<button class="admin-btn admin-btn--outline admin-btn--sm" data-promo-pause="${esc(id)}">${icon("pause")} Tạm dừng</button>`
          : status === "paused"
          ? `<button class="admin-btn admin-btn--secondary admin-btn--sm" data-promo-activate="${esc(id)}">${icon("play")} Kích hoạt</button>`
          : ""}
      </div>`;

  } else if (type === "voucher") {
    const promo = row.promo_id ? state.promotions.find(p => p.promo_id === row.promo_id) : null;
    const isPromoActive = promo ? promo.is_active : true;
    const isActive = row.is_active && isPromoActive;
    bodyHtml = `
      <dl class="admin-data-list">
        <div><dt>Mã code</dt><dd><strong style="font-size:1.125rem;color:var(--terracotta)">${esc(row.code)}</strong></dd></div>
        <div><dt>Tên</dt><dd>${esc(row.name)}</dd></div>
        <div><dt>Chiến dịch</dt><dd>${promo ? `<strong>${esc(promo.promo_name)}</strong>` : "Không thuộc chiến dịch"}</dd></div>
        <div><dt>Loại giảm</dt><dd>${esc(discountTypeLabel(row.discount_type))}</dd></div>
        <div><dt>Giá trị</dt><dd><strong>${row.discount_type==="percentage" ? row.discount_value+"%" : money(row.discount_value)}</strong></dd></div>
        <div><dt>Giảm tối đa</dt><dd>${row.max_discount_amount ? money(row.max_discount_amount) : "Không giới hạn"}</dd></div>
        <div><dt>Đơn tối thiểu</dt><dd>${money(row.min_order_value)}</dd></div>
        <div><dt>Lượt dùng</dt><dd>${row.used_count||0} / ${row.usage_limit_total||"∞"}</dd></div>
        <div><dt>Giới hạn/người</dt><dd>${row.usage_limit_per_user||1}</dd></div>
        <div><dt>Nhóm khách hàng</dt><dd>${row.applicable_user_group==="all_users" ? "Tất cả"
          : row.applicable_user_group==="new_users" ? "Khách hàng mới"
          : row.applicable_user_group==="vip_members" ? "Thành viên VIP" : esc(row.applicable_user_group||"—")}</dd></div>
        <div><dt>Danh mục áp dụng</dt><dd>${row.applicable_categories || "Tất cả danh mục"}</dd></div>
        <div><dt>Thời hạn</dt><dd>${fmtDate(row.start_date)} → ${fmtDate(row.end_date)}</dd></div>
        <div><dt>Trạng thái</dt><dd>${isActive
          ? `<span class="admin-badge admin-badge--success">Đang hoạt động</span>`
          : `<span class="admin-badge admin-badge--warning">${!row.is_active?"Tạm dừng":"Tạm dừng (Chiến dịch)"}</span>`}
          ${!isPromoActive && row.is_active ? `<small class="promo-chip promo-chip--warning" style="margin-left:6px">BR-A4-01: chiến dịch cha đang dừng</small>` : ""}</dd></div>
      </dl>
      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="admin-btn admin-btn--secondary admin-btn--sm" data-voucher-edit="${esc(row.voucher_id)}">${icon("edit")} Chỉnh sửa</button>
        <button class="admin-btn admin-btn--ghost admin-btn--sm" data-voucher-toggle="${esc(row.voucher_id)}">${icon("refresh")} ${row.is_active ? "Tạm dừng" : "Kích hoạt"}</button>
      </div>`;

  } else {
    // Bundle
    const comboId = esc(row.product_id);
    const cachedItems = (state.comboItems || {})[row.product_id] || [];
    const totalItemValue = cachedItems.reduce((sum, item) => {
      const product = (state.allProducts || []).find(p => p.product_id === item.component_product_id);
      return sum + (product ? (product.sale_price ?? product.base_price) * (item.quantity || 1) : 0);
    }, 0);
    const savings = totalItemValue - (row.sale_price ?? row.base_price);
    bodyHtml = `
      <dl class="admin-data-list">
        <div><dt>Tên Combo</dt><dd><strong>${esc(row.name)}</strong></dd></div>
        <div><dt>SKU</dt><dd><code>${esc(row.sku)}</code></dd></div>
        <div><dt>Giá gốc (tổng thành phần)</dt><dd>${money(totalItemValue)}</dd></div>
        <div><dt>Giá bán combo</dt><dd><strong style="color:var(--terracotta)">${money(row.sale_price ?? row.base_price)}</strong></dd></div>
        ${savings > 0 ? `<div><dt>Tiết kiệm</dt><dd style="color:var(--success)">${money(savings)} (-${Math.round(savings/totalItemValue*100)}%)</dd></div>` : ""}
        <div><dt>Trạng thái</dt><dd>
          <span class="admin-badge admin-badge--${row.status==="on_sale"?"success":"warning"}">${row.status==="on_sale"?"Đang bán":"Ẩn"}</span>
          <button class="admin-btn admin-btn--ghost admin-btn--sm" data-bundle-toggle="${comboId}" style="margin-left:8px">
            ${row.status==="on_sale" ? "Tạm dừng" : "Kích hoạt"}
          </button>
        </dd></div>
        <div><dt>Số thành phần</dt><dd>${cachedItems.length} sản phẩm</dd></div>
      </dl>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:20px">
        <h3 class="admin-drawer__section" style="margin:0">Thành phần combo (${cachedItems.length})</h3>
        <button class="admin-btn admin-btn--secondary admin-btn--sm" data-combo-add-item="${comboId}">${icon("plus")} Thêm</button>
      </div>
      <div id="combo-items-list" style="margin-top:10px">${cachedItems.length ? "" : "Đang tải…"}</div>`;
  }

  overlay.innerHTML = `
    <div class="admin-drawer-backdrop" data-promo-close></div>
    <aside class="admin-drawer admin-drawer--wide">
      <header class="admin-drawer__header">
        <h2>Chi tiết ${esc(type==="promotion"?"chiến dịch":type==="voucher"?"voucher":"combo")}</h2>
        <button class="admin-icon-button" data-promo-close>×</button>
      </header>
      <div class="admin-drawer__body">${bodyHtml}</div>
    </aside>`;

  if (type === "bundle") loadComboItems(row.product_id);
}

async function loadComboItems(productId) {
  const listEl = document.getElementById("combo-items-list");
  if (!listEl) return;
  try {
    const res = await productApi.comboItems(productId);
    const items = res.data?.rows || res.data || [];
    state.comboItems[productId] = items;
    if (!items.length) {
      listEl.innerHTML = `<p style="font-style:italic;color:var(--muted);font-size:0.8125rem">Chưa có thành phần nào.</p>`;
      return;
    }
    listEl.innerHTML = `
      <table class="admin-table admin-data-table" style="font-size:0.8125rem">
        <thead><tr><th>Sản phẩm</th><th>Biến thể</th><th>SL</th><th>Đơn giá</th><th></th></tr></thead>
        <tbody>${items.map(item => {
          const product = (state.allProducts || []).find(p => p.product_id === item.component_product_id);
          const variant = product?.variants?.find(v => v.variant_id === item.component_variant_id);
          const itemPrice = product ? (product.sale_price ?? product.base_price) * (item.quantity || 1) : 0;
          return `<tr>
            <td><strong>${esc(product?.name || item.component_product_id)}</strong><br>
                <small style="color:var(--muted)">${esc(product?.sku||"")}</small></td>
            <td>${esc(variant ? `${variant.color||""} ${variant.size||""}`.trim()||"—" : "—")}</td>
            <td><input type="number" class="admin-form-control" style="width:56px;height:28px;font-size:0.75rem;padding:0 4px"
              value="${esc(item.quantity)}" min="1" data-combo-update-qty="${esc(productId)}" data-item-id="${esc(item.combo_item_id)}"></td>
            <td>${money(itemPrice)}</td>
            <td><button class="admin-icon-button admin-icon-button--sm" data-combo-remove-item="${esc(productId)}" data-item-id="${esc(item.combo_item_id)}">${icon("trash")}</button></td>
          </tr>`;
        }).join("")}</tbody>
      </table>
      <div style="margin-top:10px;padding:10px 12px;background:var(--field-bg);border-radius:var(--radius-md);display:flex;justify-content:space-between">
        <span style="color:var(--muted);font-size:0.8125rem">Tổng cộng:</span>
        <strong>${items.reduce((sum, item) => {
          const p = (state.allProducts||[]).find(p => p.product_id === item.component_product_id);
          return sum + (p ? (p.sale_price ?? p.base_price) * (item.quantity||1) : 0);
        }, 0).toLocaleString("vi-VN")}đ</strong>
      </div>`;
  } catch (err) {
    listEl.innerHTML = `<p style="color:var(--error)">Lỗi tải: ${esc(err.message)}</p>`;
  }
}

// ─── CAMPAIGN FORM (Tạo / Sửa / Nhân đôi) ───────────────────────────────────
function openCampaignForm(id = null, duplicateRow = null) {
  const existing = id ? state.promotions.find(r => r.promo_id === id) : null;
  const isEdit = !!existing;
  const isDuplicate = !!duplicateRow;
  
  let row = existing || {};
  if (isDuplicate) {
    const defaultStart = new Date();
    const defaultEnd = new Date(Date.now() + 30 * 86400000);
    row = {
      promo_name: (duplicateRow.promo_name || "") + " (Bản sao)",
      promo_type: duplicateRow.promo_type || "product_discount",
      description: duplicateRow.description || "",
      highlight_label: duplicateRow.highlight_label || "",
      budget_limit: duplicateRow.budget_limit || 0,
      banner_url: duplicateRow.banner_url || "",
      start_date: defaultStart.toISOString(),
      end_date: defaultEnd.toISOString(),
    };
  }

  // Loại chiến dịch: CHỈ chọn khi tạo mới, disable khi sửa (spec mục 7)
  const typeOptions = [
    ["product_discount", "Giảm giá sản phẩm"],
    ["combo_discount",   "Giảm giá Combo"],
    ["flash_sale",       "Flash Sale"],
    ["seasonal_sale",    "Giảm giá theo mùa"],
    ["bulk_discount",    "Giảm sỉ"],
  ].map(([val, label]) =>
    `<option value="${val}" ${row.promo_type===val?"selected":""}>${label}</option>`
  ).join("");

  const bl = Number(row.budget_limit || 0);

  overlay.innerHTML = `<div class="admin-modal-overlay">
    <section class="admin-modal admin-modal--lg">
      <form data-promo-campaign-form data-id="${esc(id||"")}">
        <header class="admin-modal__header">
          <h2>${isEdit ? "Chỉnh sửa chiến dịch" : isDuplicate ? "Nhân đôi chiến dịch (Bản sao)" : "Tạo chiến dịch mới"}</h2>
          <button class="admin-icon-button" type="button" data-promo-close>×</button>
        </header>
        <div class="admin-modal__body" style="display:grid;gap:14px">

          <label class="admin-form-group">
            <span class="admin-form-label">Tên chiến dịch <b style="color:var(--error)">*</b></span>
            <input class="admin-form-control" name="promo_name" value="${esc(row.promo_name||"")}"
              required minlength="8" placeholder="Tối thiểu 8 ký tự">
            <small class="admin-form-helper">Tối thiểu 8 ký tự</small>
          </label>

          <label class="admin-form-group">
            <span class="admin-form-label">Loại chiến dịch <b style="color:var(--error)">*</b>
              ${isEdit ? `<span class="admin-badge admin-badge--neutral" style="font-size:0.7rem;margin-left:4px">Không thể đổi</span>` : ""}
            </span>
            <select class="admin-form-control" name="promo_type" ${isEdit ? "disabled" : ""} required>
              ${typeOptions}
            </select>
            ${isEdit ? `<input type="hidden" name="promo_type" value="${esc(row.promo_type)}">` : ""}
            <small class="admin-form-helper">
              ${isEdit
                ? "⚠️ Loại chiến dịch không thể thay đổi sau khi tạo (đổi sẽ làm lệch cách tính mã đã phát)."
                : "Chọn loại phù hợp — không thể đổi sau khi lưu."}
            </small>
          </label>

          <label class="admin-form-group">
            <span class="admin-form-label">Mô tả</span>
            <textarea class="admin-form-control admin-form-textarea" name="description"
              placeholder="Mô tả nội dung chiến dịch…">${esc(row.description||"")}</textarea>
          </label>

          <label class="admin-form-group">
            <span class="admin-form-label">Nhãn nổi bật <small style="color:var(--muted)">(tối đa 60 ký tự)</small></span>
            <input class="admin-form-control" name="highlight_label" maxlength="60"
              value="${esc(row.highlight_label||"")}" id="highlight-label-input"
              placeholder="VD: ⚡ Flash Sale — Để trống: hệ thống tự sinh &quot;Còn N ngày&quot; khi ≤3 ngày">
            <small class="admin-form-helper" id="highlight-label-counter">${(row.highlight_label||"").length}/60</small>
          </label>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="admin-form-group">
              <span class="admin-form-label">Ngày bắt đầu <b style="color:var(--error)">*</b></span>
              <input class="admin-form-control" name="start_date" type="datetime-local" required
                value="${row.start_date ? new Date(row.start_date).toISOString().slice(0,16) : ""}">
            </label>
            <label class="admin-form-group">
              <span class="admin-form-label">Ngày kết thúc <b style="color:var(--error)">*</b></span>
              <input class="admin-form-control" name="end_date" type="datetime-local" required
                value="${row.end_date ? new Date(row.end_date).toISOString().slice(0,16) : ""}">
            </label>
          </div>

          <label class="admin-form-group">
            <span class="admin-form-label">Ngân sách (VNĐ) <small style="color:var(--muted)">(0 = không giới hạn)</small></span>
            <input class="admin-form-control" name="budget_limit" type="number" min="0" id="budget-limit-input"
              value="${bl}" placeholder="0 = Không giới hạn">
            <small class="admin-form-helper" id="budget-limit-hint">
              ${bl === 0 ? "Không đặt trần ngân sách (BR-A4-03)." : `Đã phát: ${money(Number(row.total_discount_issued||0))} — Không được hạ xuống dưới mức này.`}
            </small>
          </label>

          <label class="admin-form-group">
            <span class="admin-form-label">Ảnh banner (URL http/https)</span>
            <input class="admin-form-control" name="banner_url" type="url" id="banner-url-input"
              value="${esc(row.banner_url||"")}" placeholder="https://…">
            <div id="banner-preview" style="margin-top:8px;display:${row.banner_url?"block":"none"}">
              ${row.banner_url ? `<img src="${esc(row.banner_url)}" alt="Banner preview"
                style="max-width:100%;max-height:140px;border-radius:var(--radius-md);border:1px solid var(--line)">
                <button type="button" id="btn-clear-banner" class="admin-btn admin-btn--ghost admin-btn--sm" style="display:block;margin-top:6px">🗑 Gỡ ảnh</button>` : ""}
            </div>
          </label>

          ${isEdit ? `<input type="hidden" name="expectedVersion" value="${esc(row.version)}">` : ""}
        </div>

        <footer class="admin-modal__footer" style="flex-direction:column;align-items:stretch;gap:8px">
          ${!isEdit ? `<p class="admin-note admin-note--warning" style="margin:0;font-size:0.8125rem;text-align:center">
            💡 Chiến dịch mới được lưu ở trạng thái <strong>Tạm dừng</strong>. Muốn chạy ngay, bấm Kích hoạt sau khi lưu.</p>` : ""}
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button class="admin-btn admin-btn--ghost" type="button" data-promo-close>Hủy</button>
            <button class="admin-btn admin-btn--secondary" type="submit">${isEdit ? "Lưu thay đổi" : "Tạo chiến dịch"}</button>
          </div>
        </footer>
      </form>
    </section>
  </div>`;

  // Bộ đếm ký tự nhãn nổi bật
  const hlInput = document.getElementById("highlight-label-input");
  const hlCounter = document.getElementById("highlight-label-counter");
  if (hlInput && hlCounter) {
    hlInput.addEventListener("input", () => {
      hlCounter.textContent = `${hlInput.value.length}/60`;
      hlCounter.style.color = hlInput.value.length >= 55 ? "var(--error)" : "";
    });
  }

  // Preview banner
  const bannerInput = document.getElementById("banner-url-input");
  const bannerPreview = document.getElementById("banner-preview");
  if (bannerInput && bannerPreview) {
    bannerInput.addEventListener("change", () => {
      const url = bannerInput.value.trim();
      if (url && /^https?:\/\//i.test(url)) {
        bannerPreview.style.display = "block";
        bannerPreview.innerHTML = `<img src="${esc(url)}" alt="Banner preview"
          style="max-width:100%;max-height:140px;border-radius:var(--radius-md);border:1px solid var(--line)"
          onerror="this.parentElement.innerHTML='<p style=color:var(--error)>URL không hợp lệ hoặc không tải được ảnh</p>'">
          <button type="button" id="btn-clear-banner" class="admin-btn admin-btn--ghost admin-btn--sm" style="display:block;margin-top:6px">🗑 Gỡ ảnh</button>`;
        bindClearBanner(bannerInput, bannerPreview);
      } else {
        bannerPreview.style.display = "none";
        bannerPreview.innerHTML = "";
      }
    });
    bindClearBanner(bannerInput, bannerPreview);
  }

  // Budget hint
  const budgetInput = document.getElementById("budget-limit-input");
  const budgetHint = document.getElementById("budget-limit-hint");
  const issued = Number(row.total_discount_issued || 0);
  if (budgetInput && budgetHint && isEdit) {
    budgetInput.addEventListener("input", () => {
      const val = Number(budgetInput.value);
      if (val === 0) {
        budgetHint.textContent = "Không đặt trần ngân sách (BR-A4-03).";
        budgetHint.style.color = "";
      } else if (issued > 0 && val < issued) {
        budgetHint.innerHTML = `⛔ Không được hạ dưới ${money(issued)} đã phát cho khách!`;
        budgetHint.style.color = "var(--error)";
      } else {
        budgetHint.textContent = `Đã phát: ${money(issued)}`;
        budgetHint.style.color = "";
      }
    });
  }
}

function bindClearBanner(bannerInput, bannerPreview) {
  const btn = document.getElementById("btn-clear-banner");
  if (btn) {
    btn.addEventListener("click", () => {
      bannerInput.value = "";
      bannerPreview.style.display = "none";
      bannerPreview.innerHTML = "";
    });
  }
}

// ─── VOUCHER EDIT FORM ────────────────────────────────────────────────────────
function openVoucherEditForm(id) {
  const row = state.vouchers.find(r => r.voucher_id === id);
  if (!row) return;
  overlay.innerHTML = `<div class="admin-modal-overlay">
    <section class="admin-modal admin-modal--lg">
      <form data-voucher-edit-form data-id="${esc(id)}">
        <header class="admin-modal__header">
          <h2>Chỉnh sửa Voucher — <code>${esc(row.code)}</code></h2>
          <button class="admin-icon-button" type="button" data-promo-close>×</button>
        </header>
        <div class="admin-modal__body" style="display:grid;gap:14px">

          <div style="padding:10px 12px;background:var(--field-bg);border-radius:var(--radius-md);font-size:0.8125rem;color:var(--muted)">
            ℹ️ Mã code (<strong>${esc(row.code)}</strong>), loại giảm và giá trị không thể thay đổi sau khi tạo.
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="admin-form-group">
              <span class="admin-form-label">Tên voucher <b style="color:var(--error)">*</b></span>
              <input class="admin-form-control" name="name" value="${esc(row.name)}" required>
            </label>
            <label class="admin-form-group">
              <span class="admin-form-label">Chiến dịch áp dụng</span>
              <select class="admin-form-control" name="promoId">
                <option value="">— Không thuộc chiến dịch —</option>
                ${state.promotions.map(p =>
                  `<option value="${esc(p.promo_id)}" ${p.promo_id===row.promo_id?"selected":""}>${esc(p.promo_name)}</option>`
                ).join("")}
              </select>
            </label>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="admin-form-group">
              <span class="admin-form-label">Giảm tối đa (VNĐ)</span>
              <input class="admin-form-control" name="maxDiscount" type="number" min="0"
                value="${esc(row.max_discount_amount||"")}" placeholder="Để trống = không giới hạn">
            </label>
            <label class="admin-form-group">
              <span class="admin-form-label">Đơn tối thiểu (VNĐ)</span>
              <input class="admin-form-control" name="minOrder" type="number" min="0"
                value="${esc(row.min_order_value||0)}">
            </label>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="admin-form-group">
              <span class="admin-form-label">Tổng lượt dùng tối đa</span>
              <input class="admin-form-control" name="maxUses" type="number" min="0"
                value="${esc(row.usage_limit_total||"")}" placeholder="Để trống = không giới hạn">
            </label>
            <label class="admin-form-group">
              <span class="admin-form-label">Giới hạn/người</span>
              <input class="admin-form-control" name="maxPerUser" type="number" min="1"
                value="${esc(row.usage_limit_per_user||1)}">
            </label>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="admin-form-group">
              <span class="admin-form-label">Danh mục áp dụng</span>
              <select class="admin-form-control" name="applicableCategories">
                <option value="">— Tất cả danh mục —</option>
                ${state.categories.map(c =>
                  `<option value="${esc(c.slug)}" ${c.slug===row.applicable_categories?"selected":""}>${esc(c.name)}</option>`
                ).join("")}
              </select>
            </label>
            <label class="admin-form-group">
              <span class="admin-form-label">Nhóm khách hàng</span>
              <select class="admin-form-control" name="applicableUserGroup">
                <option value="all_users"   ${row.applicable_user_group==="all_users"  ?"selected":""}>Tất cả khách hàng</option>
                <option value="new_users"   ${row.applicable_user_group==="new_users"  ?"selected":""}>Khách hàng mới</option>
                <option value="vip_members" ${row.applicable_user_group==="vip_members"?"selected":""}>Thành viên VIP</option>
              </select>
            </label>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="admin-form-group">
              <span class="admin-form-label">Ngày bắt đầu <b style="color:var(--error)">*</b></span>
              <input class="admin-form-control" name="start" type="datetime-local" required
                value="${row.start_date ? new Date(row.start_date).toISOString().slice(0,16) : ""}">
            </label>
            <label class="admin-form-group">
              <span class="admin-form-label">Ngày kết thúc <b style="color:var(--error)">*</b></span>
              <input class="admin-form-control" name="end" type="datetime-local" required
                value="${row.end_date ? new Date(row.end_date).toISOString().slice(0,16) : ""}">
            </label>
          </div>

          <input type="hidden" name="expectedVersion" value="${esc(row.version)}">
        </div>
        <footer class="admin-modal__footer">
          <button class="admin-btn admin-btn--ghost" type="button" data-promo-close>Hủy</button>
          <button class="admin-btn admin-btn--secondary" type="submit">Lưu thay đổi</button>
        </footer>
      </form>
    </section>
  </div>`;
}

// ─── VOUCHER CREATE FORM ──────────────────────────────────────────────────────
function openVoucherCreateForm() {
  overlay.innerHTML = `<div class="admin-modal-overlay">
    <section class="admin-modal admin-modal--lg">
      <form data-promo-form data-type="voucher">
        <header class="admin-modal__header">
          <h2>Tạo voucher mới</h2>
          <button class="admin-icon-button" type="button" data-promo-close>×</button>
        </header>
        <div class="admin-modal__body" style="display:grid;gap:14px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="admin-form-group">
              <span class="admin-form-label">Mã code <b style="color:var(--error)">*</b></span>
              <input class="admin-form-control" name="primary" required placeholder="VD: SALE50" style="text-transform:uppercase">
            </label>
            <label class="admin-form-group">
              <span class="admin-form-label">Tên voucher <b style="color:var(--error)">*</b></span>
              <input class="admin-form-control" name="name" required placeholder="Tên hiển thị">
            </label>
          </div>
          <label class="admin-form-group">
            <span class="admin-form-label">Chiến dịch áp dụng</span>
            <select class="admin-form-control" name="promoId">
              <option value="">— Không thuộc chiến dịch —</option>
              ${state.promotions.map(p => `<option value="${esc(p.promo_id)}">${esc(p.promo_name)}</option>`).join("")}
            </select>
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="admin-form-group">
              <span class="admin-form-label">Loại giảm giá <b style="color:var(--error)">*</b></span>
              <select class="admin-form-control" name="kind">
                <option value="percentage">Theo phần trăm (%)</option>
                <option value="fixed_amount">Số tiền cố định (đ)</option>
                <option value="free_shipping">Miễn phí vận chuyển</option>
              </select>
            </label>
            <label class="admin-form-group">
              <span class="admin-form-label">Giá trị <b style="color:var(--error)">*</b></span>
              <input class="admin-form-control" name="value" type="number" min="0" required>
            </label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="admin-form-group">
              <span class="admin-form-label">Giảm tối đa (VNĐ)</span>
              <input class="admin-form-control" name="maxDiscount" type="number" min="0" placeholder="Không giới hạn">
            </label>
            <label class="admin-form-group">
              <span class="admin-form-label">Đơn tối thiểu (VNĐ)</span>
              <input class="admin-form-control" name="minOrder" type="number" min="0" value="0">
            </label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="admin-form-group">
              <span class="admin-form-label">Tổng lượt dùng tối đa</span>
              <input class="admin-form-control" name="maxUses" type="number" min="0" placeholder="Không giới hạn">
            </label>
            <label class="admin-form-group">
              <span class="admin-form-label">Giới hạn/người</span>
              <input class="admin-form-control" name="maxPerUser" type="number" min="1" value="1">
            </label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="admin-form-group">
              <span class="admin-form-label">Danh mục áp dụng</span>
              <select class="admin-form-control" name="applicableCategories">
                <option value="">— Tất cả danh mục —</option>
                ${state.categories.map(c => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join("")}
              </select>
            </label>
            <label class="admin-form-group">
              <span class="admin-form-label">Nhóm khách hàng</span>
              <select class="admin-form-control" name="applicableUserGroup">
                <option value="all_users">Tất cả khách hàng</option>
                <option value="new_users">Khách hàng mới</option>
                <option value="vip_members">Thành viên VIP</option>
              </select>
            </label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="admin-form-group">
              <span class="admin-form-label">Ngày bắt đầu <b style="color:var(--error)">*</b></span>
              <input class="admin-form-control" name="start" type="datetime-local" required>
            </label>
            <label class="admin-form-group">
              <span class="admin-form-label">Ngày kết thúc <b style="color:var(--error)">*</b></span>
              <input class="admin-form-control" name="end" type="datetime-local" required>
            </label>
          </div>
        </div>
        <footer class="admin-modal__footer">
          <button class="admin-btn admin-btn--ghost" type="button" data-promo-close>Hủy</button>
          <button class="admin-btn admin-btn--secondary" type="submit">Tạo voucher</button>
        </footer>
      </form>
    </section>
  </div>`;
}

// ─── COMBO CREATE FORM ────────────────────────────────────────────────────────
function openComboCreateForm() {
  const categories = state.categories || [];
  overlay.innerHTML = `<div class="admin-modal-overlay">
    <section class="admin-modal admin-modal--lg">
      <form data-combo-create-form>
        <header class="admin-modal__header">
          <h2>Tạo Combo mới</h2>
          <button class="admin-icon-button" type="button" data-promo-close>×</button>
        </header>
        <div class="admin-modal__body" style="display:grid;gap:14px">
          <label class="admin-form-group">
            <span class="admin-form-label">Tên combo <b style="color:var(--error)">*</b></span>
            <input class="admin-form-control" name="name" required placeholder="VD: Set Đầm Dạ Hội Rose" minlength="2" maxlength="255">
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="admin-form-group">
              <span class="admin-form-label">Mã SKU <b style="color:var(--error)">*</b></span>
              <input class="admin-form-control" name="sku" required placeholder="VLR-SD-001"
                pattern="[A-Z]{2,6}-[A-Z0-9]{2,20}(-[A-Z0-9]{1,10})*">
            </label>
            <label class="admin-form-group">
              <span class="admin-form-label">Danh mục <b style="color:var(--error)">*</b></span>
              <select class="admin-form-control" name="categoryId" required>
                <option value="">— Chọn danh mục —</option>
                ${categories.map(c => `<option value="${esc(c.category_id)}"${c.slug==="set-do"?" selected":""}>${esc(c.name)}</option>`).join("")}
              </select>
            </label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="admin-form-group">
              <span class="admin-form-label">Giá gốc (VNĐ) <b style="color:var(--error)">*</b></span>
              <input class="admin-form-control" name="basePrice" type="number" min="0" required>
            </label>
            <label class="admin-form-group">
              <span class="admin-form-label">Giá bán combo (VNĐ)</span>
              <input class="admin-form-control" name="salePrice" type="number" min="0" placeholder="Để trống = giá gốc">
            </label>
          </div>
          <label class="admin-form-group">
            <span class="admin-form-label">Mô tả</span>
            <textarea class="admin-form-control admin-form-textarea" name="description" maxlength="5000" placeholder="Mô tả combo…"></textarea>
          </label>
          <label class="admin-form-group">
            <span class="admin-form-label">Ảnh đại diện (URL)</span>
            <input class="admin-form-control" name="images" type="url" placeholder="https://…">
          </label>
          <div class="admin-note admin-note--warning" style="font-size:0.8125rem">
            💡 Sau khi tạo, nhấn ✏️ để mở chi tiết và thêm thành phần vào combo.
          </div>
        </div>
        <footer class="admin-modal__footer">
          <button class="admin-btn admin-btn--ghost" type="button" data-promo-close>Hủy</button>
          <button class="admin-btn admin-btn--secondary" type="submit">Tạo combo</button>
        </footer>
      </form>
    </section>
  </div>`;
}

// ─── COMBO ADD ITEM FORM ──────────────────────────────────────────────────────
function openComboAddItemForm(productId) {
  const allProducts = state.allProducts || [];
  overlay.innerHTML = `<div class="admin-modal-overlay">
    <section class="admin-modal admin-modal--lg">
      <form data-combo-add-form data-product-id="${esc(productId)}">
        <header class="admin-modal__header">
          <h2>Thêm thành phần combo</h2>
          <button class="admin-icon-button" type="button" data-promo-close>×</button>
        </header>
        <div class="admin-modal__body" style="display:grid;gap:14px">
          <label class="admin-form-group">
            <span class="admin-form-label">Chọn sản phẩm <b style="color:var(--error)">*</b></span>
            <select class="admin-form-control" name="componentProductId" id="combo-product-select" required>
              <option value="">— Chọn sản phẩm —</option>
              ${allProducts.filter(p => !p.is_combo).map(p =>
                `<option value="${esc(p.product_id)}">${esc(p.name)} (${esc(p.sku)})</option>`
              ).join("")}
            </select>
          </label>
          <label class="admin-form-group">
            <span class="admin-form-label">Biến thể (nếu có)</span>
            <select class="admin-form-control" name="componentVariantId" id="combo-variant-select">
              <option value="">— Không chọn biến thể —</option>
            </select>
          </label>
          <label class="admin-form-group">
            <span class="admin-form-label">Số lượng <b style="color:var(--error)">*</b></span>
            <input class="admin-form-control" name="quantity" type="number" min="1" value="1" required>
          </label>
          <div id="combo-add-preview" style="display:none;padding:10px 12px;background:var(--field-bg);border-radius:var(--radius-md)">
            <strong>Xem trước:</strong> <span id="combo-add-preview-text"></span>
          </div>
        </div>
        <footer class="admin-modal__footer">
          <button class="admin-btn admin-btn--ghost" type="button" data-promo-close>Hủy</button>
          <button class="admin-btn admin-btn--secondary" type="submit">Thêm vào combo</button>
        </footer>
      </form>
    </section>
  </div>`;

  const productSelect = document.getElementById("combo-product-select");
  const variantSelect = document.getElementById("combo-variant-select");
  const preview = document.getElementById("combo-add-preview");
  const previewText = document.getElementById("combo-add-preview-text");
  if (productSelect) {
    productSelect.addEventListener("change", () => {
      variantSelect.innerHTML = '<option value="">— Không chọn biến thể —</option>';
      const pid = productSelect.value;
      if (!pid) { preview.style.display = "none"; return; }
      const product = allProducts.find(p => p.product_id === pid);
      if (product) {
        preview.style.display = "block";
        previewText.textContent = `${product.name} – ${money(product.sale_price ?? product.base_price)}`;
        (product.variants || []).forEach(v => {
          variantSelect.innerHTML += `<option value="${esc(v.variant_id)}">${esc(`${v.color||""} ${v.size||""}`.trim()||"Không có tên")} (Tồn: ${v.stock_quantity||0})</option>`;
        });
      }
    });
  }
}

// ─── DATA LOADING ─────────────────────────────────────────────────────────────
async function load() {
  state.loading = true;
  state.error = null;
  render();
  try {
    const [promotions, vouchers, bundles, logs, stats, allProducts, categories] = await Promise.all([
      pricingApi.listPromotions({ limit: 200 }),
      pricingApi.listVouchers({ limit: 500 }),
      productApi.list({ isCombo: true, limit: 100 }),
      pricingApi.auditLogs({ limit: 200 }),
      pricingApi.getStatistics().catch(() => null),
      productApi.list({ limit: 500 }).catch(() => ({ rows: [] })),
      productApi.categories().catch(() => []),
    ]);
    state.promotions = promotions.rows || [];
    state.vouchers   = vouchers.rows   || [];
    state.bundles    = (bundles.rows || []).filter(r => r.is_combo);
    state.logs       = logs.rows       || [];
    state.stats      = stats;
    state.allProducts = allProducts.rows || [];
    state.categories  = categories?.data?.rows || categories?.data || categories?.rows || (Array.isArray(categories) ? categories : []);
    state.comboItems  = {};
    await Promise.all(state.bundles.map(async bundle => {
      try {
        const res = await productApi.comboItems(bundle.product_id);
        state.comboItems[bundle.product_id] = res.data?.rows || res.data || [];
      } catch { state.comboItems[bundle.product_id] = []; }
    }));
  } catch (err) {
    state.error = err.message || "Không thể tải dữ liệu. Vui lòng thử lại.";
  } finally {
    state.loading = false;
    updateKpis();
    render();
  }
}

// ─── VERSION CONFLICT HANDLER ─────────────────────────────────────────────────
function handleVersionConflict(error, retryFn) {
  if (error?.code === "VERSION_CONFLICT" || error?.status === 409) {
    showToast("⚠️ Dữ liệu đã thay đổi bởi người khác — đang tải lại…", "error");
    load().then(retryFn);
  } else {
    showToast(error?.message || "Không thể thực hiện thao tác", "error");
  }
}

// ─── CLICK EVENTS ─────────────────────────────────────────────────────────────
document.addEventListener("click", async event => {
  // Tab switch
  const tabBtn = event.target.closest("[data-promo-view]");
  if (tabBtn) {
    state.view = tabBtn.dataset.promoView;
    state.logsPage = 1; state.comboPage = 1;
    document.querySelectorAll("[data-promo-view]").forEach(n =>
      n.classList.toggle("admin-tab--active", n === tabBtn));
    render();
    return;
  }

  // Pagination
  for (const [attr, stateKey] of [
    ["campaign-page",    "campaignPage"],
    ["voucher-page",     "voucherPage"],
    ["combo-page",       "comboPage"],
    ["promo-logs-page",  "logsPage"],
  ]) {
    const btn = event.target.closest(`[data-${attr}]`);
    if (btn) {
      const page = Number(btn.dataset[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())]);
      if (!isNaN(page) && page > 0) { state[stateKey] = page; render(); }
      return;
    }
  }

  // Detail drawer
  const detailBtn = event.target.closest("[data-promo-detail]");
  if (detailBtn) { openDetail(...detailBtn.dataset.promoDetail.split(":")); return; }

  // Campaign edit form
  const editBtn = event.target.closest("[data-promo-edit]");
  if (editBtn) {
    const [type, id] = editBtn.dataset.promoEdit.split(":");
    if (type === "promotion") { overlay.innerHTML = ""; openCampaignForm(id); }
    return;
  }

  // Campaign duplicate form
  const dupBtn = event.target.closest("[data-promo-duplicate]");
  if (dupBtn) {
    const id = dupBtn.dataset.promoDuplicate;
    const target = state.promotions.find(r => r.promo_id === id);
    if (target) { overlay.innerHTML = ""; openCampaignForm(null, target); }
    return;
  }

  // Create buttons (topbar)
  const modalBtn = event.target.closest("[data-promo-modal]");
  if (modalBtn) {
    const type = modalBtn.dataset.promoModal;
    if (type === "campaigns") openCampaignForm();
    else if (type === "vouchers") openVoucherCreateForm();
    else if (type === "combo") openComboCreateForm();
    return;
  }

  // Close overlay
  if (event.target.closest("[data-promo-close]")) { overlay.innerHTML = ""; return; }

  // Pause campaign (spec: cảnh báo trước)
  const pauseBtn = event.target.closest("[data-promo-pause]");
  if (pauseBtn) {
    const id = pauseBtn.dataset.promoPause;
    const row = state.promotions.find(r => r.promo_id === id);
    if (!row) return;
    const linked = state.vouchers.filter(v => v.promo_id === id && v.is_active).length;
    const msg = linked > 0
      ? `Tạm dừng chiến dịch sẽ tắt toàn bộ ${linked} mã giảm giá đang hiệu lực (BR-A4-02). Xác nhận?`
      : "Xác nhận tạm dừng chiến dịch?";
    if (!confirm(msg)) return;
    try {
      await pricingApi.pausePromotion(id, { expectedVersion: row.version });
      showToast("Đã tạm dừng chiến dịch");
      overlay.innerHTML = "";
      await load();
    } catch (err) { handleVersionConflict(err); }
    return;
  }

  // Activate campaign
  const activateBtn = event.target.closest("[data-promo-activate]");
  if (activateBtn) {
    const id = activateBtn.dataset.promoActivate;
    const row = state.promotions.find(r => r.promo_id === id);
    if (!row) return;
    const bl = Number(row.budget_limit || 0);
    const bu = Number(row.total_discount_issued || 0);
    if (bl > 0 && bu >= bl) {
      showToast("⛔ Không thể kích hoạt — chiến dịch đã cạn ngân sách. Hãy nâng trần trước.", "error");
      return;
    }
    try {
      await pricingApi.activatePromotion(id, { expectedVersion: row.version });
      showToast("Đã kích hoạt chiến dịch", "success");
      overlay.innerHTML = "";
      await load();
    } catch (err) { handleVersionConflict(err); }
    return;
  }

  // Voucher edit
  const voucherEditBtn = event.target.closest("[data-voucher-edit]");
  if (voucherEditBtn) { overlay.innerHTML = ""; openVoucherEditForm(voucherEditBtn.dataset.voucherEdit); return; }

  // Voucher toggle
  const voucherToggleBtn = event.target.closest("[data-voucher-toggle]");
  if (voucherToggleBtn) {
    const voucherId = voucherToggleBtn.dataset.voucherToggle;
    try {
      await pricingApi.toggleVoucher(voucherId);
      showToast("Đã cập nhật trạng thái voucher");
      overlay.innerHTML = "";
      await load();
    } catch (err) { showToast(err?.message || "Lỗi cập nhật", "error"); }
    return;
  }

  // Bundle toggle
  const bundleToggleBtn = event.target.closest("[data-bundle-toggle]");
  if (bundleToggleBtn) {
    const productId = bundleToggleBtn.dataset.bundleToggle;
    const row = state.bundles.find(r => r.product_id === productId);
    if (!row) return;
    const newStatus = row.status === "on_sale" ? "hidden" : "on_sale";
    try {
      await productApi.changeStatus(productId, { status: newStatus, expectedVersion: row.version || 0,
        reason: newStatus === "hidden" ? "Tạm dừng combo" : "Kích hoạt combo" });
      showToast(newStatus === "on_sale" ? "Đã kích hoạt combo" : "Đã tạm dừng combo");
      overlay.innerHTML = "";
      await load();
      openDetail("bundle", productId);
    } catch (err) { showToast(err?.message || "Lỗi", "error"); }
    return;
  }

  // Combo add item
  const comboAddBtn = event.target.closest("[data-combo-add-item]");
  if (comboAddBtn) { openComboAddItemForm(comboAddBtn.dataset.comboAddItem); return; }

  // Combo remove item
  const comboRemoveBtn = event.target.closest("[data-combo-remove-item]");
  if (comboRemoveBtn) {
    const productId = comboRemoveBtn.dataset.comboRemoveItem;
    const itemId    = comboRemoveBtn.dataset.itemId;
    if (!confirm("Xác nhận xóa thành phần này khỏi combo?")) return;
    try {
      await productApi.removeComboItem(productId, itemId);
      showToast("Đã xóa thành phần");
      loadComboItems(productId);
      await load();
    } catch (err) { showToast(err?.message || "Lỗi xóa", "error"); }
    return;
  }

  // Sidebar toggle
  const sidebarBtn = event.target.closest("[data-promo-sidebar]");
  if (sidebarBtn) {
    document.getElementById("admin-sidebar")?.classList.toggle("is-collapsed");
    return;
  }
});

// ─── CHANGE EVENTS ────────────────────────────────────────────────────────────
document.addEventListener("change", async event => {
  if (event.target.matches("[data-combo-update-qty]")) {
    const input = event.target;
    const qty = Number(input.value);
    if (!Number.isInteger(qty) || qty < 1) { showToast("Số lượng không hợp lệ", "error"); return; }
    try {
      await productApi.updateComboItem(input.dataset.comboUpdateQty, input.dataset.itemId, { quantity: qty });
      showToast("Đã cập nhật số lượng");
    } catch (err) { showToast(err?.message || "Lỗi cập nhật", "error"); }
  }
});

// ─── FORM SUBMIT EVENTS ───────────────────────────────────────────────────────
document.addEventListener("submit", async event => {

  // ── Create/Edit Campaign ──
  if (event.target.matches("[data-promo-campaign-form]")) {
    event.preventDefault();
    const form = event.target;
    const id   = form.dataset.id || null;
    const submitBtn = form.querySelector("[type=submit]");
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Đang xử lý…"; }

    const startDate = new Date(form.elements.start_date.value);
    const endDate   = new Date(form.elements.end_date.value);
    if (endDate <= startDate) {
      showToast("Ngày kết thúc phải sau ngày bắt đầu", "error");
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = id ? "Lưu thay đổi" : "Tạo chiến dịch"; }
      return;
    }
    if (form.elements.promo_name.value.trim().length < 8) {
      showToast("Tên chiến dịch tối thiểu 8 ký tự", "error");
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = id ? "Lưu thay đổi" : "Tạo chiến dịch"; }
      return;
    }

    let highlightLabel = form.elements.highlight_label?.value.trim() || null;
    // Gap 5: Nhãn nổi bật tự động sinh "Còn N ngày" khi để trống và kết thúc trong ≤3 ngày
    if (!highlightLabel && endDate > startDate) {
      const daysLeft = Math.ceil((endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (daysLeft > 0 && daysLeft <= 3) {
        highlightLabel = `Còn ${daysLeft} ngày`;
      }
    }

    const body = {
      name:           form.elements.promo_name.value.trim(),
      description:    form.elements.description?.value.trim() || null,
      highlightLabel: highlightLabel,
      startDate:      startDate.toISOString(),
      endDate:        endDate.toISOString(),
      budgetLimit:    Number(form.elements.budget_limit?.value || 0),
      bannerUrl:      form.elements.banner_url?.value.trim() || null,
    };
    if (!id) body.type = form.elements.promo_type?.value;

    try {
      if (id) {
        body.expectedVersion = Number(form.elements.expectedVersion?.value);
        // Validate: không hạ ngân sách dưới mức đã phát
        const existing = state.promotions.find(r => r.promo_id === id);
        const issued = Number(existing?.total_discount_issued || 0);
        if (body.budgetLimit > 0 && issued > 0 && body.budgetLimit < issued) {
          showToast(`⛔ Không được hạ ngân sách dưới ${money(issued)} đã phát cho khách!`, "error");
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Lưu thay đổi"; }
          return;
        }
        await pricingApi.updatePromotion(id, body);
        showToast("Đã cập nhật chiến dịch");
      } else {
        await pricingApi.createPromotion(body);
        showToast("Tạo chiến dịch thành công! Trạng thái ban đầu: Tạm dừng.");
      }
      overlay.innerHTML = "";
      await load();
    } catch (err) { handleVersionConflict(err, () => openCampaignForm(id)); }
    return;
  }

  // ── Create Voucher ──
  if (event.target.matches("[data-promo-form][data-type='voucher']")) {
    event.preventDefault();
    const form = event.target;
    const submitBtn = form.querySelector("[type=submit]");
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Đang xử lý…"; }
    try {
      await pricingApi.createVoucher({
        code:                  form.elements.primary.value.trim().toUpperCase(),
        name:                  form.elements.name.value.trim(),
        promoId:               form.elements.promoId.value || null,
        type:                  form.elements.kind.value,
        value:                 Number(form.elements.value.value),
        maxDiscount:           form.elements.maxDiscount?.value ? Number(form.elements.maxDiscount.value) : null,
        minOrderValue:         Number(form.elements.minOrder?.value || 0),
        maxUses:               Number(form.elements.maxUses?.value) || null,
        maxPerUser:            Number(form.elements.maxPerUser?.value || 1),
        applicableCategories:  form.elements.applicableCategories?.value || null,
        applicableUserGroup:   form.elements.applicableUserGroup?.value || "all_users",
        startDate:             new Date(form.elements.start.value).toISOString(),
        endDate:               new Date(form.elements.end.value).toISOString(),
      });
      showToast("Tạo voucher thành công!");
      overlay.innerHTML = "";
      await load();
    } catch (err) {
      showToast(err?.message || "Không thể tạo voucher", "error");
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Tạo voucher"; }
    }
    return;
  }

  // ── Edit Voucher ──
  if (event.target.matches("[data-voucher-edit-form]")) {
    event.preventDefault();
    const form = event.target;
    const id   = form.dataset.id;
    const submitBtn = form.querySelector("[type=submit]");
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Đang lưu…"; }
    try {
      await pricingApi.updateVoucher(id, {
        name:                  form.elements.name.value.trim(),
        promoId:               form.elements.promoId.value || null,
        maxDiscount:           form.elements.maxDiscount?.value ? Number(form.elements.maxDiscount.value) : null,
        minOrderValue:         Number(form.elements.minOrder?.value || 0),
        maxUses:               Number(form.elements.maxUses?.value) || null,
        maxPerUser:            Number(form.elements.maxPerUser?.value || 1),
        applicableCategories:  form.elements.applicableCategories?.value || null,
        applicableUserGroup:   form.elements.applicableUserGroup?.value || "all_users",
        startDate:             new Date(form.elements.start.value).toISOString(),
        endDate:               new Date(form.elements.end.value).toISOString(),
        expectedVersion:       Number(form.elements.expectedVersion?.value),
      });
      showToast("Đã cập nhật voucher");
      overlay.innerHTML = "";
      await load();
    } catch (err) { handleVersionConflict(err, () => openVoucherEditForm(id)); }
    return;
  }

  // ── Create Combo ──
  if (event.target.matches("[data-combo-create-form]")) {
    event.preventDefault();
    const form = event.target;
    const submitBtn = form.querySelector("[type=submit]");
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Đang tạo…"; }

    const rawSku = form.elements.sku.value.trim().toUpperCase();
    const skuPattern = /^VLR-[A-Z0-9]{2}-\d{3}$/;
    if (!skuPattern.test(rawSku)) {
      showToast("⚠️ Mã SKU Combo phải đúng định dạng VLR-XX-000 (Ví dụ: VLR-CB-001)", "error");
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Tạo combo"; }
      return;
    }

    try {
      const name = form.elements.name.value.trim();
      const slug = name.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
      await productApi.create({
        sku:          rawSku,
        name, slug,
        description:  form.elements.description?.value.trim() || null,
        categoryId:   form.elements.categoryId.value,
        basePrice:    Number(form.elements.basePrice.value),
        salePrice:    form.elements.salePrice?.value ? Number(form.elements.salePrice.value) : Number(form.elements.basePrice.value),
        images:       form.elements.images?.value.trim() ? [form.elements.images.value.trim()] : [],
        isCombo:      true, status: "on_sale", expectedVersion: 0,
      });
      showToast("Tạo combo thành công! Nhấn ✏️ để thêm thành phần.");
      overlay.innerHTML = "";
      await load();
    } catch (err) {
      showToast(err?.message || "Không thể tạo combo", "error");
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Tạo combo"; }
    }
    return;
  }

  // ── Add Combo Item ──
  if (event.target.matches("[data-combo-add-form]")) {
    event.preventDefault();
    const form = event.target;
    const productId = form.dataset.productId;
    const submitBtn = form.querySelector("[type=submit]");
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Đang thêm…"; }
    try {
      await productApi.addComboItem(productId, {
        componentProductId: form.elements.componentProductId.value.trim(),
        componentVariantId: form.elements.componentVariantId?.value.trim() || null,
        quantity:           Number(form.elements.quantity.value),
      });
      showToast("Đã thêm thành phần vào combo!");
      overlay.innerHTML = "";
      loadComboItems(productId);
      await load();
    } catch (err) {
      showToast(err?.message || "Không thể thêm thành phần", "error");
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Thêm vào combo"; }
    }
    return;
  }
});

// ─── EXPORT ───────────────────────────────────────────────────────────────────
document.querySelector("[data-promo-export]")?.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({
    promotions: state.promotions,
    vouchers:   state.vouchers,
    bundles:    state.bundles,
    statistics: state.stats,
  }, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob), download: "velura-promotions-export.json"
  });
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("Đã xuất báo cáo");
});

// ─── INIT ─────────────────────────────────────────────────────────────────────
load();
