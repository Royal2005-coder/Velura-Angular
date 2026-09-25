import { productApi } from "./product-api.js";

(function () {
  "use strict";

  const state = { products: [], categories: [], lowStock: [], selectedProductId: "", filtered: [], currentPage: 1, itemsPerPage: 10 };
  const layout = document.querySelector(".admin-layout");
  const tableBody = document.querySelector("#product-list");
  const searchInput = document.querySelector("[data-product-search]");
  const categoryFilter = document.querySelector("[data-product-category]");
  const statusFilter = document.querySelector("[data-product-status]");
  const stockFilter = document.querySelector("[data-product-stock]");
  const productModal = document.querySelector("#product-form");
  const productForm = document.querySelector("[data-product-form]");
  const stopModal = document.querySelector("#product-stop-modal");
  const stopForm = document.querySelector("[data-product-stop-form]");
  const stockModal = document.querySelector("#product-stock-modal");
  const stockForm = document.querySelector("[data-product-stock-form]");
  const drawer = document.querySelector("#product-detail");
  const backdrop = document.querySelector(".admin-drawer-backdrop");

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[character]);
  }

  function safeImageUrl(value) {
    const url = String(value || "");
    if (url.startsWith("../../assets/images/")) return url;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" ? parsed.href : "../../assets/images/product-silk-blazer.png";
    } catch {
      return "../../assets/images/product-silk-blazer.png";
    }
  }

  function formatPrice(value) {
    return `${Number(value || 0).toLocaleString("vi-VN")}đ`;
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(date);
  }

  function icon(name) {
    return `<svg class="admin-line-icon"><use href="../../assets/icons/admin-icons.svg#${escapeHtml(name)}" /></svg>`;
  }

  function statusLabel(status) {
    return ({ on_sale: "Đang bán", hidden: "Tạm ẩn", out_of_stock: "Hết hàng", discontinued: "Ngừng kinh doanh" })[status] || status;
  }

  function statusBadge(status) {
    const tone = ({ on_sale: "active", hidden: "warning", out_of_stock: "danger", discontinued: "neutral" })[status] || "neutral";
    return `<span class="admin-badge admin-badge--${tone}">${escapeHtml(statusLabel(status))}</span>`;
  }

  function categoryName(product) {
    return product.category?.name || state.categories.find((item) => item.category_id === product.category_id)?.name || "—";
  }

  function variantsOf(product) {
    return Array.isArray(product.variants) ? product.variants : [];
  }

  function stockOf(product) {
    return variantsOf(product).reduce((sum, variant) => sum + Number(variant.stock_quantity || 0), 0);
  }

  function stockClass(stock) {
    if (stock === 0) return "admin-stock--out";
    if (stock < 10) return "admin-stock--low";
    return "admin-stock--ok";
  }

  function formatApiError(error) {
    if (error?.details && typeof error.details === "object") {
      const messages = Object.values(error.details).flat().filter(Boolean);
      if (messages.length > 0) return messages.join("; ");
    }
    return error?.message || "Đã xảy ra lỗi không xác định.";
  }

  function showToast(message, isError = false) {
    const toast = document.querySelector("#product-toast");
    toast.textContent = typeof message === "string" ? message : formatApiError(message);
    toast.classList.toggle("is-error", isError);
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 4500);
  }

  function currentRows() {
    const query = searchInput.value.trim().toLowerCase();
    return state.products.filter((product) => {
      const stock = stockOf(product);
      const searchMatch = !query || `${product.name} ${product.sku}`.toLowerCase().includes(query);
      const categoryMatch = !categoryFilter.value || product.category_id === categoryFilter.value;
      const statusMatch = !statusFilter.value || product.status === statusFilter.value;
      const stockMatch = !stockFilter.value
        || (stockFilter.value === "low" && stock > 0 && variantsOf(product).some((v) => Number(v.stock_quantity) <= Number(v.low_stock_threshold)))
        || (stockFilter.value === "out" && stock === 0);
      return searchMatch && categoryMatch && statusMatch && stockMatch;
    });
  }

  function renderPagination() {
    const paginationContainer = document.querySelector(".admin-pagination");
    if (!paginationContainer) return;
    
    const totalItems = state.filtered.length;
    const totalPages = Math.ceil(totalItems / state.itemsPerPage) || 1;
    if (totalPages <= 1) {
      paginationContainer.innerHTML = "";
      return;
    }
    
    let buttons = "";
    buttons += `<button type="button" data-product-page="${state.currentPage - 1}" ${state.currentPage === 1 ? "disabled" : ""}>←</button>`;
    
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
      buttons += `<button type="button" class="${state.currentPage === i ? "is-active" : ""}" data-product-page="${i}">${i}</button>`;
    }
    
    buttons += `<button type="button" data-product-page="${state.currentPage + 1}" ${state.currentPage === totalPages ? "disabled" : ""}>→</button>`;
    paginationContainer.innerHTML = buttons;
  }

  function renderProducts() {
    state.filtered = currentRows();
    const totalItems = state.filtered.length;
    const catalogTabSpan = document.querySelector('[data-product-tab="catalog"] span');
    if (catalogTabSpan) {
      catalogTabSpan.textContent = String(totalItems);
    }
    const totalPages = Math.ceil(totalItems / state.itemsPerPage) || 1;
    if (state.currentPage > totalPages) {
      state.currentPage = totalPages;
    }
    if (state.currentPage < 1) {
      state.currentPage = 1;
    }

    const start = (state.currentPage - 1) * state.itemsPerPage;
    const end = start + state.itemsPerPage;
    const pagedRows = state.filtered.slice(start, end);

    if (!pagedRows.length) {
      tableBody.innerHTML = `<tr><td colspan="8"><div class="admin-empty-state">${icon("search")}<strong>Không có sản phẩm phù hợp</strong></div></td></tr>`;
    } else {
      tableBody.innerHTML = pagedRows.map((product) => {
        const stock = stockOf(product);
        const image = safeImageUrl(product.images?.[0]);
        return `<tr>
          <td><div class="admin-table__entity"><img src="${escapeHtml(image)}" alt=""><span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.brand || product.collection || "")}</small></span></div></td>
          <td>${escapeHtml(product.sku)}</td>
          <td><span class="admin-role-badge">${escapeHtml(categoryName(product))}</span></td>
          <td>${formatPrice(product.sale_price)}</td>
          <td><span class="admin-stock ${stockClass(stock)}">${stock}</span></td>
          <td>${statusBadge(product.status)}</td>
          <td>${escapeHtml(formatDate(product.updated_at))}</td>
          <td><div class="admin-table-actions">
            <button class="admin-icon-button admin-icon-button--sm" title="Xem chi tiết" data-product-drawer="${escapeHtml(product.product_id)}">${icon("eye")}</button>
            <span class="admin-product-actions"><button class="admin-icon-button admin-icon-button--sm" title="Thao tác" data-product-menu="${escapeHtml(product.product_id)}">${icon("edit")}</button>
              <span class="admin-dropdown admin-table-action-menu" id="product-menu-${escapeHtml(product.product_id)}" hidden>
                <button data-product-drawer="${escapeHtml(product.product_id)}">${icon("eye")}<span>Xem chi tiết</span></button>
                <button data-product-modal="product-form" data-product-id="${escapeHtml(product.product_id)}">${icon("edit")}<span>Cập nhật</span></button>
                <button data-product-stop="${escapeHtml(product.product_id)}">${icon("lock")}<span>Đổi trạng thái</span></button>
              </span>
            </span>
          </div></td>
        </tr>`;
      }).join("");
    }
    updateKpis();
    const note = document.querySelector(".admin-card__footer .admin-table-note");
    if (note) {
      const showStart = totalItems === 0 ? 0 : start + 1;
      const showEnd = Math.min(end, totalItems);
      note.textContent = `Hiển thị ${showStart} - ${showEnd} / ${totalItems} sản phẩm`;
    }
    renderPagination();
  }

  function updateKpis() {
    const cards = document.querySelectorAll(".admin-product-kpis .admin-kpi-card__value");
    const counts = [
      state.totalCount || state.products.length,
      state.products.filter((p) => p.status === "on_sale").length,
      state.products.filter((p) => p.status === "hidden").length,
      state.products.filter((p) => p.status === "out_of_stock" || stockOf(p) === 0).length,
      state.lowStock.length
    ];
    cards.forEach((card, index) => { card.textContent = String(counts[index] || 0); });
  }

  function renderCategories() {
    const options = state.categories.map((category) => `<option value="${escapeHtml(category.category_id)}">${escapeHtml(category.name)}</option>`).join("");
    categoryFilter.innerHTML = `<option value="">Tất cả danh mục</option>${options}`;
    const formSelect = productForm.elements.category;
    formSelect.innerHTML = `<option value="">Chọn danh mục</option>${options}`;
  }

  function openProductModal(productId = "") {
    const product = state.products.find((item) => item.product_id === productId);
    productForm.reset();
    productForm.dataset.productId = productId;
    productModal.querySelector("#product-form-title").textContent = product ? "Cập nhật sản phẩm" : "Thêm sản phẩm";
    productForm.elements.sku.disabled = Boolean(product);
    productForm.querySelectorAll('[name="status"]').forEach((input) => {
      input.disabled = !product && !["on_sale", "hidden"].includes(input.value);
    });
    if (product) {
      productForm.elements.name.value = product.name || "";
      productForm.elements.sku.value = product.sku || "";
      productForm.elements.category.value = product.category_id || "";
      productForm.elements.price.value = product.sale_price ?? 0;
      productForm.elements.originalPrice.value = product.base_price ?? product.sale_price ?? 0;
      productForm.elements.collection.value = product.collection || "";
      productForm.elements.description.value = product.description || "";
      productForm.elements.aiTags.value = (product.style_tags || []).join(", ");
      productForm.elements.imageUrl.value = product.images?.[0] || "";
      
      const variants = product.variants || [];
      const totalStock = variants.reduce((sum, v) => sum + Number(v.stock_quantity || 0), 0);
      productForm.elements.stock.value = String(totalStock);
      if (variants.length <= 1) {
        productForm.elements.minStock.value = variants.length === 1 ? String(variants[0].low_stock_threshold ?? 5) : "5";
        productForm.elements.stock.disabled = false;
        productForm.elements.minStock.disabled = false;
      } else {
        productForm.elements.minStock.value = variants.length > 0 ? String(variants[0].low_stock_threshold ?? 5) : "5";
        productForm.elements.stock.disabled = true;
        productForm.elements.minStock.disabled = true;
      }
    } else {
      productForm.elements.stock.value = "0";
      productForm.elements.minStock.value = "5";
      productForm.elements.stock.disabled = false;
      productForm.elements.minStock.disabled = false;
    }
    productForm.elements.price.disabled = Boolean(product);
    productForm.elements.originalPrice.disabled = Boolean(product);
    const status = product?.status || "on_sale";
    const radio = productForm.querySelector(`[name="status"][value="${CSS.escape(status)}"]`);
    if (radio) radio.checked = true;
    productModal.hidden = false;
  }

  async function openProductDrawer(productId) {
    const product = state.products.find((item) => item.product_id === productId);
    if (!product) return;
    state.selectedProductId = productId;
    drawer.innerHTML = `<div class="admin-empty-state"><strong>Đang tải chi tiết...</strong></div>`;
    drawer.hidden = false;
    backdrop.hidden = false;
    try {
      const result = await productApi.variants(productId);
      product.variants = result?.data?.rows || result?.data || [];
      renderDrawer(product);
    } catch (error) {
      drawer.innerHTML = `<div class="admin-empty-state"><strong>Không thể tải biến thể</strong><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  function renderDrawer(product) {
    const variants = variantsOf(product);
    const variantRows = variants.length ? variants.map((variant) => `<tr>
      <td>${escapeHtml(variant.color || "—")}</td><td>${escapeHtml(variant.size || "—")}</td>
      <td>${Number(variant.stock_quantity || 0)}</td><td>${Number(variant.reserved_quantity || 0)}</td>
      <td><button class="admin-icon-button admin-icon-button--sm" title="Điều chỉnh tồn kho" data-stock-variant="${escapeHtml(variant.variant_id)}">${icon("edit")}</button></td>
    </tr>`).join("") : `<tr><td colspan="5">Chưa có biến thể.</td></tr>`;
    drawer.innerHTML = `<header class="admin-drawer__header"><div><h2 class="admin-section__title">${escapeHtml(product.name)}</h2><p class="admin-product-code">${escapeHtml(product.sku)}</p>${statusBadge(product.status)}</div><button class="admin-icon-button" data-product-close aria-label="Đóng">×</button></header>
      <div class="admin-drawer__body">
        <h3 class="admin-drawer__section">Thông tin sản phẩm</h3>
        <div class="admin-product-basic-list"><div><span>Danh mục</span><strong>${escapeHtml(categoryName(product))}</strong></div><div><span>Phiên bản</span><strong>v${Number(product.version || 1)}</strong></div><div><span>Giá bán</span><strong>${formatPrice(product.sale_price)}</strong></div><div><span>Cập nhật</span><strong>${escapeHtml(formatDate(product.updated_at))}</strong></div></div>
        <p class="admin-product-description">${escapeHtml(product.description || "Chưa có mô tả")}</p>
        <h3 class="admin-drawer__section" style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
          <span>Biến thể và tồn kho</span>
          <div style="display: inline-flex; gap: 8px;">
            <button class="admin-btn admin-btn--outline admin-btn--sm" type="button" data-product-variant-add="${escapeHtml(product.product_id)}">Thêm biến thể</button>
            <button class="admin-btn admin-btn--outline admin-btn--sm" type="button" data-product-stock-bulk="${escapeHtml(product.product_id)}">Cập nhật hàng loạt</button>
          </div>
        </h3>
        <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Màu</th><th>Size</th><th>Tồn</th><th>Đã giữ</th><th></th></tr></thead><tbody>${variantRows}</tbody></table></div>
      </div>`;
  }

  function openVariantModal(productId) {
    const product = state.products.find((item) => item.product_id === productId);
    if (!product) return;
    document.querySelector("#product-variant-modal")?.remove();
    document.body.insertAdjacentHTML("beforeend", `<div class="admin-modal-overlay" id="product-variant-modal">
      <section class="admin-modal" role="dialog" aria-modal="true">
        <form data-product-variant-form data-product-id="${escapeHtml(productId)}">
          <header class="admin-modal__header"><div><p class="label-upper">Quản lý tồn kho</p><h2>Thêm biến thể</h2></div><button class="admin-icon-button" type="button" data-product-variant-close aria-label="Đóng">×</button></header>
          <div class="admin-modal__body">
            <label class="admin-form-group"><span class="admin-form-label">Màu sắc <b>*</b></span><input class="admin-form-control" name="color" required placeholder="Ví dụ: Đen"></label>
            <label class="admin-form-group"><span class="admin-form-label">Mã màu</span><input class="admin-form-control" name="colorHex" placeholder="#000000"></label>
            <label class="admin-form-group"><span class="admin-form-label">Size <b>*</b></span><input class="admin-form-control" name="size" required placeholder="S, M, L"></label>
            <label class="admin-form-group"><span class="admin-form-label">Tồn kho ban đầu <b>*</b></span><input class="admin-form-control" name="stockQuantity" type="number" min="0" step="1" required></label>
            <label class="admin-form-group"><span class="admin-form-label">Ngưỡng cảnh báo</span><input class="admin-form-control" name="lowStockThreshold" type="number" min="0" step="1" value="5"></label>
          </div>
          <footer class="admin-modal__footer"><button class="admin-btn admin-btn--ghost" type="button" data-product-variant-close>Hủy</button><button class="admin-btn admin-btn--secondary">Tạo biến thể</button></footer>
        </form>
      </section>
    </div>`);
  }

  function allowedStatusTargets(status) {
    return ({
      on_sale: ["hidden", "out_of_stock", "discontinued"],
      hidden: ["on_sale", "out_of_stock", "discontinued"],
      out_of_stock: ["on_sale", "hidden", "discontinued"],
      discontinued: ["hidden"]
    })[status] || [];
  }

  function openStatusModal(productId) {
    const product = state.products.find((item) => item.product_id === productId);
    if (!product) return;
    stopForm.reset();
    stopForm.dataset.productId = productId;
    stopModal.querySelector("[data-product-stop-name]").textContent = product.name;
    stopModal.querySelector("[data-product-stop-sku]").textContent = product.sku;
    stopModal.querySelector("[data-product-stop-status]").textContent = statusLabel(product.status);
    stopModal.querySelector("[data-product-stop-stock]").textContent = `${stockOf(product)} sản phẩm`;
    const options = stopModal.querySelector(".admin-product-stop-options");
    const targets = allowedStatusTargets(product.status);
    options.innerHTML = targets.map((status, index) => `<label><input type="radio" name="nextStatus" value="${status}" ${index === 0 ? "checked" : ""}><span><strong>${escapeHtml(statusLabel(status))}</strong></span></label>`).join("");
    
    // Set initial submit button text matching the default checked option
    const firstOption = targets[0];
    const submitBtn = stopModal.querySelector("[data-product-stop-submit]");
    if (submitBtn) {
      submitBtn.textContent = firstOption ? `Xác nhận ${statusLabel(firstOption).toLowerCase()}` : "Xác nhận";
    }
    
    stopModal.hidden = false;
  }

  function openStockModal(variantId) {
    const product = state.products.find((item) => item.product_id === state.selectedProductId);
    const variant = variantsOf(product || {}).find((item) => item.variant_id === variantId);
    if (!product || !variant || !stockModal || !stockForm) return;
    stockForm.reset();
    stockForm.dataset.productId = product.product_id;
    stockForm.dataset.variantId = variant.variant_id;
    stockForm.dataset.version = String(variant.version || 1);
    stockModal.querySelector("[data-stock-product]").textContent = product.name;
    stockModal.querySelector("[data-stock-variant-label]").textContent = `${variant.color || "—"} / ${variant.size || "—"}`;
    stockModal.querySelector("[data-stock-current]").textContent = String(variant.stock_quantity || 0);
    stockForm.elements.lowStockThreshold.value = String(variant.low_stock_threshold ?? 5);
    stockModal.hidden = false;
  }

  async function submitProduct(event) {
    event.preventDefault();
    const submit = productModal.querySelector("[type=submit]");
    const productId = productForm.dataset.productId || "";
    const current = state.products.find((item) => item.product_id === productId);
    const name = productForm.elements.name.value.trim();
    const status = productForm.elements.status.value;
    const categoryId = productForm.elements.category.value;
    if (!categoryId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(categoryId)) {
      showToast("Vui lòng chọn danh mục hợp lệ từ danh sách.");
      return;
    }
    const payload = {
      name,
      categoryId,
      collection: productForm.elements.collection.value.trim() || null,
      description: productForm.elements.description.value.trim() || null,
      images: productForm.elements.imageUrl.value.trim() ? [productForm.elements.imageUrl.value.trim()] : [],
      styleTags: productForm.elements.aiTags.value.split(",").map((item) => item.trim()).filter(Boolean)
    };
    submit.disabled = true;
    try {
      if (current) {
        payload.expectedVersion = current.version;
        if (!productForm.elements.stock.disabled) {
          payload.stock = Number(productForm.elements.stock.value || 0);
          payload.minStock = Number(productForm.elements.minStock.value || 5);
        }
        await productApi.update(productId, payload);
        if (status !== current.status) {
          const latest = await productApi.get(productId);
          await productApi.changeStatus(productId, { status, reason: "Cập nhật trạng thái từ biểu mẫu sản phẩm", expectedVersion: latest.version });
        }
        showToast("Đã cập nhật sản phẩm.");
      } else {
        Object.assign(payload, {
          sku: productForm.elements.sku.value.trim().toUpperCase(),
          slug: slugify(name),
          basePrice: Number(productForm.elements.originalPrice.value || productForm.elements.price.value),
          salePrice: Number(productForm.elements.price.value),
          status,
          expectedVersion: 0,
          images: payload.images,
          initialStock: Number(productForm.elements.stock.value || 0),
          lowStockThreshold: Number(productForm.elements.minStock.value || 5)
        });
        await productApi.create(payload);
        showToast("Đã tạo sản phẩm.");
      }
      productModal.hidden = true;
      await loadState();
    } catch (error) {
      showToast(formatApiError(error), true);
    } finally {
      submit.disabled = false;
    }
  }

  async function submitStatus(event) {
    event.preventDefault();
    const product = state.products.find((item) => item.product_id === stopForm.dataset.productId);
    if (!product) return;
    try {
      await productApi.changeStatus(product.product_id, {
        status: stopForm.elements.nextStatus.value,
        reason: stopForm.elements.reason.value,
        expectedVersion: product.version
      });
      stopModal.hidden = true;
      showToast("Đã cập nhật trạng thái sản phẩm.");
      await loadState();
    } catch (error) {
      showToast(formatApiError(error), true);
    }
  }

  async function submitStock(event) {
    event.preventDefault();
    try {
      await productApi.updateStock(stockForm.dataset.productId, {
        variantId: stockForm.dataset.variantId,
        delta: Number(stockForm.elements.delta.value),
        lowStockThreshold: Number(stockForm.elements.lowStockThreshold.value),
        reason: stockForm.elements.reason.value,
        expectedVersion: Number(stockForm.dataset.version)
      });
      stockModal.hidden = true;
      showToast("Đã điều chỉnh tồn kho.");
      await loadState();
      await openProductDrawer(stockForm.dataset.productId);
    } catch (error) {
      showToast(error.message, true);
    }
  }

  async function submitVariant(event) {
    event.preventDefault();
    const form = event.target;
    try {
      await productApi.createVariant(form.dataset.productId, {
        color: form.elements.color.value.trim(),
        colorHex: form.elements.colorHex.value.trim() || null,
        size: form.elements.size.value.trim(),
        stockQuantity: Number(form.elements.stockQuantity.value),
        lowStockThreshold: Number(form.elements.lowStockThreshold.value || 5)
      });
      document.querySelector("#product-variant-modal")?.remove();
      showToast("Đã tạo biến thể tồn kho.");
      await loadState();
      await openProductDrawer(form.dataset.productId);
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function openBulkStockModal(productId) {
    const product = state.products.find((item) => item.product_id === productId);
    if (!product) return;
    document.querySelector("#product-bulk-stock-modal")?.remove();
    
    const variants = variantsOf(product);
    const variantInputs = variants.map((variant) => `
      <div style="display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line);">
        <span><strong>${escapeHtml(variant.color || "—")} / ${escapeHtml(variant.size || "—")}</strong><br><small style="color:var(--muted)">Tồn hiện tại: ${variant.stock_quantity}</small></span>
        <label class="admin-form-group" style="margin-bottom:0">
          <input class="admin-form-control" name="delta_${variant.variant_id}" type="number" step="1" value="0" placeholder="Thay đổi (ví dụ: +10, -5)" required>
        </label>
        <label class="admin-form-group" style="margin-bottom:0">
          <input class="admin-form-control" name="threshold_${variant.variant_id}" type="number" min="0" step="1" value="${variant.low_stock_threshold ?? 5}" required>
        </label>
      </div>
    `).join("");

    document.body.insertAdjacentHTML("beforeend", `
      <div class="admin-modal-overlay" id="product-bulk-stock-modal" style="display: grid; place-items: center; z-index: 310;">
        <section class="admin-modal" style="width: min(600px, 95vw); max-height: 90vh; display: flex; flex-direction: column;" role="dialog" aria-modal="true">
          <form data-product-bulk-stock-form data-product-id="${escapeHtml(productId)}">
            <header class="admin-modal__header">
              <div>
                <p class="label-upper">Quản lý tồn kho theo lô</p>
                <h2>Cập nhật tồn kho hàng loạt</h2>
              </div>
              <button class="admin-icon-button" type="button" data-product-bulk-stock-close aria-label="Đóng">×</button>
            </header>
            <div class="admin-modal__body" style="overflow-y: auto; max-height: 50vh;">
              <p style="margin-bottom: 16px; font-size: 0.875rem; color: var(--muted);">
                Sản phẩm: <strong>${escapeHtml(product.name)}</strong> (${escapeHtml(product.sku)})
              </p>
              <div style="display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 12px; font-size: 0.75rem; text-transform: uppercase; color: var(--muted); font-weight: 600; padding-bottom: 6px; border-bottom: 2px solid var(--line);">
                <span>Biến thể</span>
                <span>Số lượng thay đổi</span>
                <span>Ngưỡng cảnh báo</span>
              </div>
              ${variantInputs || '<p style="padding: 16px 0; text-align: center;">Chưa có biến thể nào.</p>'}
              
              <label class="admin-form-group" style="margin-top: 20px;">
                <span class="admin-form-label">Lý do điều chỉnh lô <b>*</b></span>
                <textarea class="admin-form-control admin-form-textarea" name="reason" minlength="10" maxlength="500" required placeholder="Nhập lý do nhập/xuất kho lô này (tối thiểu 10 ký tự)..."></textarea>
              </label>
            </div>
            <footer class="admin-modal__footer">
              <button class="admin-btn admin-btn--ghost" type="button" data-product-bulk-stock-close>Hủy</button>
              <button class="admin-btn admin-btn--secondary" type="submit">Xác nhận cập nhật</button>
            </footer>
          </form>
        </section>
      </div>
    `);
  }

  async function submitBulkStock(event) {
    event.preventDefault();
    const form = event.target;
    const productId = form.dataset.productId;
    const product = state.products.find((item) => item.product_id === productId);
    if (!product) return;

    const updates = [];
    const reason = form.elements.reason.value.trim();

    variantsOf(product).forEach((variant) => {
      const deltaInput = form.elements[`delta_${variant.variant_id}`];
      const thresholdInput = form.elements[`threshold_${variant.variant_id}`];
      
      const delta = deltaInput ? Number(deltaInput.value) : 0;
      const threshold = thresholdInput ? Number(thresholdInput.value) : 5;

      if (delta !== 0 || threshold !== variant.low_stock_threshold) {
        updates.push({
          variantId: variant.variant_id,
          delta,
          lowStockThreshold: threshold,
          expectedVersion: variant.version || 1
        });
      }
    });

    if (updates.length === 0) {
      showToast("Không có thay đổi nào được thực hiện.");
      document.querySelector("#product-bulk-stock-modal")?.remove();
      return;
    }

    try {
      const submitBtn = form.querySelector("button[type='submit']");
      if (submitBtn) submitBtn.disabled = true;
      
      await productApi.bulkUpdateStock(productId, {
        updates,
        reason
      });

      document.querySelector("#product-bulk-stock-modal")?.remove();
      showToast("Đã cập nhật tồn kho hàng loạt thành công.");
      await loadState();
      await openProductDrawer(productId);
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function slugify(value) {
    return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/đ/g, "d").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }

  function downloadText(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportProducts() {
    const header = ["sku", "name", "category", "sale_price", "stock", "status"];
    const rows = currentRows().map((product) => [
      product.sku, product.name, categoryName(product), product.sale_price, stockOf(product), product.status
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadText("velura-products.csv", csv, "text/csv;charset=utf-8");
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  let lastCsvContent = "";

  async function previewCsv(file) {
    const resultElement = document.querySelector("[data-product-csv-result]");
    const actionsElement = document.querySelector("[data-product-csv-actions]");
    if (!file || file.size > 60 * 1024) {
      resultElement.textContent = "File CSV phải nhỏ hơn hoặc bằng 60 KB.";
      if (actionsElement) actionsElement.hidden = true;
      return;
    }
    resultElement.textContent = "Đang kiểm tra dữ liệu...";
    try {
      lastCsvContent = await file.text();
      const result = await productApi.previewCsv(lastCsvContent);
      resultElement.textContent = `Hợp lệ: ${result.validRows}/${result.totalRows} dòng. Đây là bước preview, chưa ghi dữ liệu.`;
      if (actionsElement) actionsElement.hidden = !(result.validRows > 0);
    } catch (error) {
      lastCsvContent = "";
      if (actionsElement) actionsElement.hidden = true;
      const rowErrors = error.details?.errors;
      resultElement.textContent = Array.isArray(rowErrors)
        ? `CSV có lỗi: ${rowErrors.slice(0, 3).map((item) => `dòng ${item.row} ${item.field}`).join(", ")}.`
        : error.message;
    }
  }

  async function commitCsv() {
    const resultElement = document.querySelector("[data-product-csv-result]");
    const actionsElement = document.querySelector("[data-product-csv-actions]");
    if (!lastCsvContent) {
      resultElement.textContent = "Không có dữ liệu CSV để nhập.";
      return;
    }
    resultElement.textContent = "Đang nhập dữ liệu...";
    if (actionsElement) actionsElement.hidden = true;
    try {
      const data = await productApi.commitCsv(lastCsvContent);
      let detailText = `Nhập thành công: tạo mới ${data.created || 0}, cập nhật ${data.updated || 0}. Thất bại: ${data.failed || 0}.`;
      if (Array.isArray(data.results)) {
        const errors = data.results.filter((r) => r.status === "error");
        if (errors.length > 0) {
          detailText += "\n\nChi tiết lỗi:\n" + errors.map((e) => `• SKU ${e.sku}: ${e.message}`).join("\n");
        }
      }
      resultElement.innerText = detailText;
      lastCsvContent = "";
      if (actionsElement) actionsElement.hidden = true;
      await loadState();
    } catch (error) {
      resultElement.textContent = `Lỗi khi nhập: ${error.message}`;
    }
  }

  async function loadAuditLogs() {
    const body = document.querySelector("[data-product-log-list]");
    if (!body) return;
    body.innerHTML = `<tr><td colspan="6">Đang tải nhật ký...</td></tr>`;
    try {
      const result = await productApi.auditLogs();
      const rows = result?.rows || [];
      body.innerHTML = rows.length ? rows.map((log) => `<tr>
        <td>${escapeHtml(formatDate(log.timestamp))}</td>
        <td>${escapeHtml(log.actor_id || "—")}<br><small>${escapeHtml(log.actor_role || "")}</small></td>
        <td>${escapeHtml(log.target_id || "—")}</td>
        <td>${escapeHtml(log.action || "—")}</td>
        <td><small>${escapeHtml(JSON.stringify(log.new_value || {})).slice(0, 180)}</small></td>
        <td><span class="admin-badge admin-badge--success">Thành công</span></td>
      </tr>`).join("") : `<tr><td colspan="6">Chưa có nhật ký sản phẩm.</td></tr>`;
    } catch (error) {
      body.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  function updateKpis() {
    const kpiCards = document.querySelectorAll(".admin-product-kpis .admin-kpi-card__value");
    if (kpiCards.length >= 5) {
      const total = state.products.length;
      const onSale = state.products.filter(p => p.status === "on_sale").length;
      const hidden = state.products.filter(p => p.status === "hidden").length;
      const outOfStock = state.products.filter(p => p.status === "out_of_stock" || stockOf(p) === 0).length;
      const lowStock = state.products.filter(p => {
        const stock = stockOf(p);
        return stock > 0 && variantsOf(p).some((v) => Number(v.stock_quantity) <= Number(v.low_stock_threshold));
      }).length;

      kpiCards[0].textContent = String(total);
      kpiCards[1].textContent = String(onSale);
      kpiCards[2].textContent = String(hidden);
      kpiCards[3].textContent = String(outOfStock);
      kpiCards[4].textContent = String(lowStock);
    }
  }

  async function loadState() {
    tableBody.innerHTML = `<tr><td colspan="8"><div class="admin-empty-state"><strong>Đang tải dữ liệu Supabase...</strong></div></td></tr>`;
    const [products, categories, lowStock] = await Promise.all([
      productApi.list({ limit: 1000 }), productApi.categories(), productApi.lowStock()
    ]);
    state.products = products?.rows || [];
    state.totalCount = products?.count || state.products.length;
    state.categories = categories?.data?.rows || categories?.data || [];
    state.lowStock = lowStock?.data || [];
    renderCategories();
    updateKpis();
    renderProducts();
  }

  document.addEventListener("click", (event) => {
    const sidebar = event.target.closest("[data-product-sidebar]");
    const modal = event.target.closest("[data-product-modal]");
    const drawerButton = event.target.closest("[data-product-drawer]");
    const close = event.target.closest("[data-product-close]");
    const stop = event.target.closest("[data-product-stop]");
    const stopClose = event.target.closest("[data-product-stop-close]");
    const stock = event.target.closest("[data-stock-variant]");
    const variantAdd = event.target.closest("[data-product-variant-add]");
    const bulkStockBtn = event.target.closest("[data-product-stock-bulk]");
    const bulkStockClose = event.target.closest("[data-product-bulk-stock-close]");
    const variantClose = event.target.closest("[data-product-variant-close]");
    const stockClose = event.target.closest("[data-product-stock-close]");
    const menuButton = event.target.closest("[data-product-menu]");
    const tab = event.target.closest("[data-product-tab]");
    const exportButton = event.target.closest("[data-product-export]");
    const csvChoose = event.target.closest("[data-product-csv-choose]");
    const csvTemplate = event.target.closest("[data-product-csv-template]");
    const pageBtn = event.target.closest("[data-product-page]");
    if (pageBtn) {
      const page = Number(pageBtn.dataset.productPage);
      if (!Number.isNaN(page) && page > 0) {
        state.currentPage = page;
        renderProducts();
      }
      return;
    }

    if (sidebar) layout.classList.toggle("admin-layout--sidebar-collapsed");
    if (modal) openProductModal(modal.dataset.productId || "");
    if (drawerButton) openProductDrawer(drawerButton.dataset.productDrawer);
    if (stop) openStatusModal(stop.dataset.productStop);
    if (stock) openStockModal(stock.dataset.stockVariant);
    if (variantAdd) openVariantModal(variantAdd.dataset.productVariantAdd);
    if (bulkStockBtn) openBulkStockModal(bulkStockBtn.dataset.productStockBulk);
    if (bulkStockClose) document.querySelector("#product-bulk-stock-modal")?.remove();
    if (variantClose) document.querySelector("#product-variant-modal")?.remove();
    if (menuButton) {
      const menu = document.querySelector(`#product-menu-${CSS.escape(menuButton.dataset.productMenu)}`);
      document.querySelectorAll(".admin-table-action-menu").forEach((item) => { if (item !== menu) item.hidden = true; });
      menu.hidden = !menu.hidden;
    }
    if (close) { productModal.hidden = true; drawer.hidden = true; backdrop.hidden = true; }
    if (stopClose) stopModal.hidden = true;
    if (stockClose && stockModal) stockModal.hidden = true;
    if (exportButton) exportProducts();
    if (csvChoose) document.querySelector("[data-product-csv-file]").click();
    if (csvTemplate) downloadText(
      "velura-products-template.csv",
      "sku,name,base_price,category_id,description,sale_price,status,is_featured\r\n",
      "text/csv;charset=utf-8"
    );
    if (tab) {
      document.querySelectorAll("[data-product-tab]").forEach((item) => item.classList.toggle("admin-tab--active", item === tab));
      document.querySelectorAll("[data-product-panel]").forEach((panel) => { panel.hidden = panel.dataset.productPanel !== tab.dataset.productTab; });
      if (tab.dataset.productTab === "logs") loadAuditLogs();
    }
  });

  [searchInput, categoryFilter, statusFilter, stockFilter].forEach((control) => {
    control.addEventListener("input", () => {
      state.currentPage = 1;
      renderProducts();
    });
    control.addEventListener("change", () => {
      state.currentPage = 1;
      renderProducts();
    });
  });
  document.querySelector("[data-product-filter]").addEventListener("reset", () => {
    state.currentPage = 1;
    setTimeout(renderProducts, 0);
  });
  document.querySelector("[data-product-filter]").addEventListener("submit", (event) => {
    event.preventDefault();
    state.currentPage = 1;
    renderProducts();
  });
  productForm.addEventListener("submit", submitProduct);
  document.addEventListener("submit", (event) => {
    if (event.target.matches("[data-product-variant-form]")) submitVariant(event);
    if (event.target.matches("[data-product-bulk-stock-form]")) submitBulkStock(event);
  });
  stopForm.addEventListener("submit", submitStatus);
  stopForm.addEventListener("change", (event) => {
    if (event.target.name === "nextStatus") {
      const submitBtn = stopModal.querySelector("[data-product-stop-submit]");
      if (submitBtn) {
        submitBtn.textContent = `Xác nhận ${statusLabel(event.target.value).toLowerCase()}`;
      }
    }
  });
  if (stockForm) stockForm.addEventListener("submit", submitStock);
  document.querySelector("[data-product-csv-file]")?.addEventListener("change", (event) => previewCsv(event.target.files?.[0]));
  document.querySelector("[data-product-csv-commit]")?.addEventListener("click", commitCsv);
  loadState().catch((error) => {
    tableBody.innerHTML = `<tr><td colspan="8"><div class="admin-empty-state">${icon("alert")}<strong>Không thể tải dữ liệu sản phẩm</strong><p>${escapeHtml(error.message)}</p></div></td></tr>`;
  });
})();
