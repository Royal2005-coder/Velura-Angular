import { HttpError } from "../http.js";
import { selectRows, insertRow, selectOne, updateRows } from "../supabase.js";
import {
  asJsonObject,
  asString,
  errorMessage,
  type AuthContext,
  type JsonObject,
  type RequestMeta
} from "../types.js";
import {
  PRODUCT_ADMIN_ROLES,
  PRODUCT_VIEWER_ROLES,
  PRODUCT_STATUSES,
  PRODUCT_AUDIT_ACTION_TYPES,
  STATUS_TRANSITIONS,
  SKU_PATTERN,
  SKU_DUPLICATE_MESSAGE,
  MIN_CHANGE_REASON_LENGTH,
  CSV_MAX_ROWS,
  CSV_REQUIRED_COLUMNS,
  type ProductAuditActionType
} from "./product-constants.js";
import type { ProductRepository } from "./product-repository.js";
import { invalidateCatalogCache } from "../user/products.js";
import { StudioImageApprovalService } from "./product-studio-approval.js";
import { SupabaseEnhancementApprovalRepository } from "../ai/enhancement-approval-repository.js";
import {
  analyzeProductImageQuality,
  enhanceProductImageStudio,
  generateProductFashionSeo
} from "./product-ai-studio.js";

/**
 * Admin product use-cases used by `handleProductRoute`.
 * Product images are ordered (index 0 is primary); imageColors explicitly maps URLs to exact variant colors.
 * New products and their initial variants are persisted atomically by the create RPC.
 */
export interface ProductService {
  list(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<unknown>;
  get(context: AuthContext | undefined, productId: string): Promise<unknown>;
  getVariants(context: AuthContext | undefined, productId: string): Promise<unknown>;
  categories(context: AuthContext | undefined): Promise<unknown>;
  create(context: AuthContext | undefined, body: JsonObject, requestMeta: RequestMeta): Promise<unknown>;
  update(context: AuthContext | undefined, productId: string, body: JsonObject, requestMeta: RequestMeta): Promise<unknown>;
  changeStatus(context: AuthContext | undefined, productId: string, body: JsonObject, requestMeta: RequestMeta): Promise<unknown>;
  updateStock(context: AuthContext | undefined, productId: string, body: JsonObject, requestMeta: RequestMeta): Promise<unknown>;
  bulkUpdateStock(context: AuthContext | undefined, productId: string, body: JsonObject, requestMeta: RequestMeta): Promise<unknown>;
  createVariant(context: AuthContext | undefined, productId: string, body: JsonObject, requestMeta: RequestMeta): Promise<unknown>;
  /**
   * Preview product/variant SKU rows. Duplicate SKUs inside the file and every other row error are blocking;
   * a price that differs from the stored price is a non-blocking warning (the stored price is kept, never overwritten).
   */
  parseCsv(context: AuthContext | undefined, csvContent: unknown): Promise<unknown>;
  /** Revalidate raw CSV and atomically persist all rows; existing prices are never updated and skipped prices are reported in `warnings`. */
  commitCsv(context: AuthContext | undefined, csvContent: unknown, requestMeta: RequestMeta): Promise<unknown>;
  /** Variants at or below their own low-stock threshold, enriched with product name/SKU for the dashboard and catalog filter. */
  lowStock(context: AuthContext | undefined): Promise<unknown>;
  /**
   * Server-side filtered product audit log: from/to (YYYY-MM-DD, Asia/Ho_Chi_Minh), product name/SKU, actionType
   * (CREATE | UPDATE | UPDATE_STATUS | UPDATE_STOCK) and user (name, email or id); legacy `q`, `date`, `action` still work.
   */
  listAuditLogs(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<unknown>;
  /** Inline SKU availability check: product and variant SKUs share one case-insensitive namespace. */
  checkSku(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<unknown>;
  getComboItems(context: AuthContext | undefined, productId: string): Promise<unknown>;
  addComboItem(context: AuthContext | undefined, productId: string, body: JsonObject, requestMeta: RequestMeta): Promise<unknown>;
  updateComboItem(
    context: AuthContext | undefined,
    productId: string,
    itemId: string,
    body: JsonObject,
    requestMeta: RequestMeta
  ): Promise<unknown>;
  removeComboItem(context: AuthContext | undefined, productId: string, itemId: string): Promise<unknown>;
  analyzeImageQuality(context: AuthContext | undefined, body: JsonObject): Promise<unknown>;
  enhanceProductImage(context: AuthContext | undefined, body: JsonObject): Promise<unknown>;
  /** Store an explicit Studio selection as a measured database-backed approval; never publish here. */
  approveStudioImage(context: AuthContext | undefined, body: JsonObject, requestMeta: RequestMeta): Promise<unknown>;
  optimizeProductSeo(context: AuthContext | undefined, body: JsonObject): Promise<unknown>;
}

/**
 * Create the admin product application service without startup timers or repository I/O.
 * Stock/status alignment runs only within authorized product mutations, using the operator's token and audit reason.
 */
export function createProductService({ repository }: { repository: ProductRepository }): ProductService {
  if (!repository) throw new TypeError("repository is required");

  return {
    async list(context, searchParams) {
      requireProductViewer(context);
      const filters = parseListFilters(searchParams);
      if (filters.lowStock === true) {
        const productIds = [...new Set((await listLowStockVariants(repository, context.accessToken)).map((row) => asString(row.product_id)).filter(Boolean))];
        if (!productIds.length) return { rows: [], count: 0 };
        filters.productIds = productIds;
      }
      return repository.list(filters, context.accessToken);
    },

    async get(context, productId) {
      requireProductViewer(context);
      requireUuid(productId, "productId");
      const product = await repository.findById(productId, context.accessToken);
      if (!product) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Không tìm thấy sản phẩm");
      return product;
    },

    async getVariants(context, productId) {
      requireProductViewer(context);
      requireUuid(productId, "productId");
      return repository.listVariants(productId, context.accessToken);
    },

    async categories(context) {
      requireProductViewer(context);
      return repository.listCategories(context.accessToken);
    },

    async create(context, body, requestMeta) {
      requireProductAdmin(context, body?.isCombo === true);
      const input = validateCreateProduct(body);
      input.ipAddress = requestMeta.ipAddress || "0.0.0.0";

      // If material is specified and not in description, append it
      if (body?.material && typeof body.material === "string") {
        const mat = body.material.trim();
        if (mat && !input.description?.includes(mat)) {
          input.description = input.description ? `${input.description}\nChất liệu: ${mat}` : `Chất liệu: ${mat}`;
        }
      }

      await assertSkusAvailable(repository, context, [input.sku, ...input.variants.map((variant) => variant.sku ?? "")]);
      const product = asJsonObject(await repository.createProduct(input, context.accessToken));
      if (typeof repository.findById === "function" && typeof repository.listVariants === "function") {
        await syncProductStockStatus(repository, context, product.product_id as string, "Khởi tạo tồn kho sản phẩm mới", input.ipAddress);
      }
      invalidateCatalogCache();
      return product;
    },

    async update(context, productId, body, requestMeta) {
      requireUuid(productId, "productId");
      const current = await repository.findById(productId, context?.accessToken ?? null);
      if (!current) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product was not found");
      requireProductAdmin(context, current.is_combo === true);
      const input = validateUpdateProduct(body);
      const images = input.images ?? (Array.isArray(current.images) ? current.images as string[] : []);
      if (input.images !== undefined) requirePrimaryImage(images, current.status);
      if (input.imageColors !== undefined || input.images !== undefined) {
        const variants = await repository.listVariants(productId, context.accessToken);
        const list = Array.isArray(variants) ? variants : variants.rows;
        const colors = list.map((variant) => asString(variant.color));
        const mapping = input.imageColors ?? Object.fromEntries(
          Object.entries(asJsonObject(current.image_colors)).filter(([url]) => images.includes(url))
        );
        input.imageColors = validateImageColorLinks(mapping, images, colors);
      }
      input.ipAddress = requestMeta.ipAddress || "0.0.0.0";
      const result = await repository.updateProduct(productId, input, context.accessToken);

      // If stock/threshold are passed, update the default/first variant
      const stock = body.stock !== undefined ? Number(body.stock) : undefined;
      const minStock = body.minStock !== undefined ? Number(body.minStock) : undefined;

      if (stock !== undefined || minStock !== undefined) {
        const variants = await repository.listVariants(productId, context.accessToken);
        const list = variants?.rows || (Array.isArray(variants) ? variants : []);
        
        if (list.length === 1) {
          const firstVariant = list[0];
          let variantUpdated = false;
          if (stock !== undefined) {
            const delta = stock - Number(firstVariant.stock_quantity || 0);
            if (delta !== 0) {
              await repository.updateStock(productId, firstVariant.variant_id as string, {
                delta,
                reason: "Điều chỉnh tồn kho từ biểu mẫu sản phẩm",
                expectedVersion: firstVariant.version || 1,
                ipAddress: input.ipAddress
              }, context.accessToken);
              variantUpdated = true;
            }
          }
          if (minStock !== undefined) {
            await updateRows("variant", { variant_id: `eq.${firstVariant.variant_id}` }, {
              low_stock_threshold: minStock,
              version: (firstVariant.version as number || 0) + 1,
              updated_at: new Date().toISOString()
            });
            variantUpdated = true;
          }
          if (variantUpdated) {
            await syncProductStockStatus(repository, context, productId, "Đồng bộ tồn kho từ biểu mẫu sản phẩm", input.ipAddress);
          }
        }
      }
      invalidateCatalogCache();
      return result;
    },

    async changeStatus(context, productId, body, requestMeta) {
      requireUuid(productId, "productId");
      const current = await repository.findById(productId, context?.accessToken ?? null);
      if (!current) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Không tìm thấy sản phẩm");
      requireProductAdmin(context, current.is_combo === true);
      const input = validateStatusChange(body);
      if (current.status === input.status) {
        throw validationError("status", `Sản phẩm đã ở trạng thái ${statusVi(input.status)}`);
      }
      if (!STATUS_TRANSITIONS[current.status as string]?.includes(input.status)) {
        throw validationError("status", `Không thể chuyển trạng thái từ ${statusVi(asString(current.status))} sang ${statusVi(input.status)}`);
      }
      if (input.status === "on_sale") requirePrimaryImage(validateImageUrls(current.images), input.status);
      input.ipAddress = requestMeta.ipAddress || "0.0.0.0";
      const changed = await repository.changeStatus(productId, input, context.accessToken);
      invalidateCatalogCache();
      return changed;
    },

    async updateStock(context, productId, body, requestMeta) {
      requireUuid(productId, "productId");
      const current = await repository.findById(productId, context?.accessToken ?? null);
      if (!current) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Không tìm thấy sản phẩm");
      requireProductAdmin(context, current.is_combo === true);
      requireUuid(body?.variantId, "variantId");

      const delta = Number(body?.delta || 0);
      const lowStockThreshold = body?.lowStockThreshold !== undefined ? Number(body.lowStockThreshold) : undefined;
      const reason = String(body?.reason || "").trim();
      const ipAddress = requestMeta.ipAddress || "0.0.0.0";

      if (!Number.isInteger(delta)) {
        throw validationError("delta", "Số lượng điều chỉnh phải là số nguyên");
      }
      if (delta === 0 && lowStockThreshold === undefined) {
        throw validationError("delta", "Số lượng điều chỉnh phải khác 0 hoặc phải nhập ngưỡng cảnh báo mới");
      }
      if (reason.length < MIN_CHANGE_REASON_LENGTH) {
        throw validationError("reason", `Lý do điều chỉnh tồn kho tối thiểu ${MIN_CHANGE_REASON_LENGTH} ký tự`);
      }

      let result: unknown = { success: true };
      if (delta !== 0) {
        const input = validateStockUpdate(body);
        input.ipAddress = ipAddress;
        result = await repository.updateStock(productId, body.variantId as string, input, context.accessToken);
      }

      if (lowStockThreshold !== undefined) {
        if (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0) {
          throw validationError("lowStockThreshold", "Ngưỡng cảnh báo tồn phải là số nguyên không âm");
        }
        const freshVariant = await selectOne("variant", { variant_id: `eq.${body.variantId}` });
        if (freshVariant) {
          await updateRows("variant", { variant_id: `eq.${body.variantId}` }, {
            low_stock_threshold: lowStockThreshold,
            version: (freshVariant.version as number) + 1,
            updated_at: new Date().toISOString()
          });
        }
      }

      await syncProductStockStatus(repository, context, productId, reason, ipAddress);
      const lowStockAlert = await checkAndAlertLowStock(repository, context, productId, body.variantId as string);
      return { ...asJsonObject(result), lowStockAlert };
    },

    async bulkUpdateStock(context, productId, body, requestMeta) {
      requireUuid(productId, "productId");
      const current = await repository.findById(productId, context?.accessToken ?? null);
      if (!current) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Không tìm thấy sản phẩm");
      requireProductAdmin(context, current.is_combo === true);

      if (!body || !Array.isArray(body.updates)) {
        throw validationError("updates", "Danh sách điều chỉnh tồn kho phải là một mảng");
      }
      const reason = String(body.reason || "").trim();
      if (reason.length < MIN_CHANGE_REASON_LENGTH) {
        throw validationError("reason", `Lý do điều chỉnh tồn kho tối thiểu ${MIN_CHANGE_REASON_LENGTH} ký tự`);
      }

      const ipAddress = requestMeta.ipAddress || "0.0.0.0";
      const results: JsonObject[] = [];
      const updates = body.updates as JsonObject[];

      for (const update of updates) {
        requireUuid(update.variantId, "variantId");
        const delta = Number(update.delta || 0);
        const lowStockThreshold = update.lowStockThreshold !== undefined ? Number(update.lowStockThreshold) : undefined;
        
        if (!Number.isInteger(delta)) {
          throw validationError("delta", "Số lượng điều chỉnh phải là số nguyên");
        }
        if (lowStockThreshold !== undefined && (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0)) {
          throw validationError("lowStockThreshold", "Ngưỡng cảnh báo tồn phải là số nguyên không âm");
        }

        // Apply updates
        if (delta !== 0) {
          await repository.updateStock(productId, update.variantId as string, {
            delta,
            reason,
            expectedVersion: update.expectedVersion || 1,
            ipAddress
          }, context.accessToken);
        }

        if (lowStockThreshold !== undefined) {
          const freshVariant = await selectOne("variant", { variant_id: `eq.${update.variantId}` });
          if (freshVariant) {
            await updateRows("variant", { variant_id: `eq.${update.variantId}` }, {
              low_stock_threshold: lowStockThreshold,
              version: (freshVariant.version as number) + 1,
              updated_at: new Date().toISOString()
            });
          }
        }
        results.push({ variantId: update.variantId, success: true });
      }

      await syncProductStockStatus(repository, context, productId, reason, ipAddress);

      const lowStockAlerts: LowStockAlert[] = [];
      for (const update of updates) {
        const alert = await checkAndAlertLowStock(repository, context, productId, update.variantId as string);
        if (alert) lowStockAlerts.push(alert);
      }

      return { success: true, results, lowStockAlerts };
    },

    async createVariant(context, productId, body, requestMeta) {
      requireUuid(productId, "productId");
      const current = await repository.findById(productId, context?.accessToken ?? null);
      if (!current) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Không tìm thấy sản phẩm");
      requireProductAdmin(context, current.is_combo === true);
      const input = validateCreateVariant(body);
      input.ipAddress = requestMeta.ipAddress || "0.0.0.0";
      const result = asJsonObject(await repository.createVariant(productId, input, context.accessToken));
      await syncProductStockStatus(repository, context, productId, "Cập nhật tồn kho biến thể sản phẩm", input.ipAddress);
      await checkAndAlertLowStock(repository, context, productId, result.variant_id as string);
      return result;
    },

    async parseCsv(context, csvContent) {
      requireProductAdmin(context);
      const lines = parseCsvLines(csvContent);
      if (lines.length === 0) throw validationError("csv", "File CSV trống");
      if (lines.length - 1 > CSV_MAX_ROWS) throw validationError("csv", `File CSV tối đa ${CSV_MAX_ROWS} dòng dữ liệu`);
      const headers = lines[0].map((header) => header.trim().toLowerCase());
      const missing = CSV_REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
      if (missing.length) throw validationError("csv", `Thiếu cột bắt buộc: ${missing.join(", ")}`);
      const errors: JsonObject[] = [];
      const warnings: JsonObject[] = [];
      const rows: JsonObject[] = [];
      const repeatedHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
      for (const field of new Set(repeatedHeaders)) {
        errors.push({ row: 1, field, message: "Tên cột CSV bị lặp" });
      }
      if (headers.some((header) => !header)) errors.push({ row: 1, field: "csv", message: "Tên cột CSV không được trống" });
      const skuRows = new Map<string, number[]>();
      for (let index = 1; index < lines.length; index++) {
        const sku = (lines[index][headers.indexOf("sku")] || "").trim().toUpperCase();
        if (sku) skuRows.set(sku, [...(skuRows.get(sku) || []), index + 1]);
      }
      for (let index = 1; index < lines.length; index++) {
        const row = parseCsvRow(headers, lines[index]);
        const rowNum = index + 1;
        const startErrors = errors.length;
        const reject = (field: string, message: string) => { errors.push({ row: rowNum, field, message }); };
        const sku = row.sku.toUpperCase();
        const parentSku = (row.product_sku || "").toUpperCase();
        if ((skuRows.get(sku)?.length || 0) > 1) {
          const others = (skuRows.get(sku) || []).filter((other) => other !== rowNum);
          reject("sku", `SKU ${sku} bị lặp trong file (cùng dòng ${others.join(", ")}); mỗi SKU chỉ được xuất hiện một lần, không phân biệt hoa/thường và khoảng trắng`);
        }
        if (lines[index].length !== headers.length) reject("csv", "Số ô không khớp số cột CSV");
        if (!SKU_PATTERN.test(sku)) reject("sku", "SKU không đúng dạng VL-AO001");
        if (parentSku && !SKU_PATTERN.test(parentSku)) reject("product_sku", "SKU sản phẩm cha không hợp lệ");
        if (!row.name || row.name.length < 2 || row.name.length > 200) reject("name", "Tên bắt buộc, từ 2 đến 200 ký tự");
        const basePrice = Number(row.base_price);
        if (!row.base_price || !Number.isFinite(basePrice) || basePrice < 0) reject("base_price", "Giá gốc phải là số không âm");
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.category_id || "")) {
          reject("category_id", "category_id phải là UUID danh mục");
        }
        const salePrice = row.sale_price ? Number(row.sale_price) : null;
        if (salePrice !== null && (!Number.isFinite(salePrice) || salePrice < 0)) reject("sale_price", "Giá bán phải là số không âm");
        if (row.status && !PRODUCT_STATUSES.includes(row.status)) reject("status", "Trạng thái phải là on_sale, hidden, out_of_stock hoặc discontinued");
        const variant = SKU_PATTERN.test(sku) ? await repository.findVariantBySku(sku, context.accessToken) : null;
        const skuProduct = SKU_PATTERN.test(sku) ? await repository.findBySku(sku, context.accessToken) : null;
        const product = variant
          ? await repository.findById(String(variant.product_id), context.accessToken)
          : parentSku && SKU_PATTERN.test(parentSku) ? await repository.findBySku(parentSku, context.accessToken) : skuProduct;
        if (variant && skuProduct && variant.product_id !== skuProduct.product_id) {
          reject("sku", "SKU trùng sản phẩm và biến thể thuộc sản phẩm khác; cần sửa SKU trước khi nhập");
        }
        if (!variant && parentSku && skuProduct && product && skuProduct.product_id !== product.product_id) {
          reject("sku", "SKU đã thuộc sản phẩm khác");
        }
        if (parentSku && (!product || String(product.sku).trim().toUpperCase() !== parentSku)) {
          reject("product_sku", "Không tìm thấy sản phẩm cha hoặc SKU đã thuộc sản phẩm khác");
        }
        // CSV never changes an existing product's price: a differing value is skipped with a warning and the stored price is kept.
        const skippedPrices: string[] = [];
        if (product) {
          const storedBase = Number(product.base_price);
          const storedSale = Number(product.sale_price);
          if (Number.isFinite(basePrice) && basePrice !== storedBase) {
            skippedPrices.push("base_price");
            warnings.push({ row: rowNum, field: "base_price", severity: "warning", csv_value: basePrice, current_value: storedBase,
              message: `Giá gốc trong CSV (${formatVnd(basePrice)}) khác giá hiện tại (${formatVnd(storedBase)}); CSV không đổi giá nên giữ nguyên ${formatVnd(storedBase)}` });
          }
          if (salePrice !== null && Number.isFinite(salePrice) && salePrice !== storedSale) {
            skippedPrices.push("sale_price");
            warnings.push({ row: rowNum, field: "sale_price", severity: "warning", csv_value: salePrice, current_value: storedSale,
              message: `Giá bán trong CSV (${formatVnd(salePrice)}) khác giá hiện tại (${formatVnd(storedSale)}); CSV không đổi giá nên giữ nguyên ${formatVnd(storedSale)}` });
          }
        } else if (row.status && !["on_sale", "hidden"].includes(row.status)) {
          reject("status", "Sản phẩm mới chỉ được Đang bán hoặc Tạm ẩn");
        }
        const newVariant = Boolean(parentSku && product && !variant);
        if (newVariant && !row.color) reject("color", "Biến thể mới bắt buộc có màu");
        if (newVariant && !row.size) reject("size", "Biến thể mới bắt buộc có size");
        if (row.color && row.color.length > 50) reject("color", "Màu tối đa 50 ký tự");
        if (row.size && row.size.length > 10) reject("size", "Size tối đa 10 ký tự");
        if (row.color_hex && !/^#[0-9a-f]{6}$/i.test(row.color_hex)) reject("color_hex", "Màu phải có dạng #RRGGBB");
        for (const field of ["stock_quantity", "low_stock_threshold"]) {
          if (row[field] && (!Number.isSafeInteger(Number(row[field])) || Number(row[field]) < 0 || Number(row[field]) > 2147483647)) reject(field, "Phải là số nguyên không âm");
        }
        if (row.stock_quantity && variant && Number(row.stock_quantity) < Number(variant.reserved_quantity || 0)) reject("stock_quantity", "Tồn kho không được thấp hơn số lượng đã giữ");
        if (product && !variant && !newVariant && ["color", "size", "color_hex", "stock_quantity", "low_stock_threshold"].some((field) => row[field])) {
          reject("sku", "Dùng SKU biến thể; thêm product_sku khi tạo biến thể mới");
        }
        if (row.image_url) {
          try { validateImageUrls([row.image_url]); } catch { reject("image_url", "URL ảnh không hợp lệ"); }
          if (!product || !Array.isArray(product.images) || !product.images.includes(row.image_url)) {
            reject("image_url", "Ảnh mới phải được phê duyệt trong Product Editor trước khi nhập CSV");
          }
        }
        if (!product && (row.status || "on_sale") === "on_sale") reject("status", "Nhập sản phẩm mới ở trạng thái hidden rồi phê duyệt ảnh trong Product Editor");
        if (errors.length !== startErrors || repeatedHeaders.length) continue;
        rows.push({
          row: rowNum, sku, product_sku: parentSku || null, name: row.name,
          base_price: product ? Number(product.base_price) : basePrice,
          sale_price: product && skippedPrices.includes("sale_price") ? Number(product.sale_price) : salePrice,
          csv_base_price: basePrice, csv_sale_price: salePrice, skipped_prices: skippedPrices,
          category_id: row.category_id, description: row.description || null,
          status: row.status || null, image_url: row.image_url || null,
          is_featured: row.is_featured ? row.is_featured === "true" : null,
          color: row.color || null, size: row.size ? row.size.toUpperCase() : null,
          color_hex: row.color_hex || null,
          stock_quantity: row.stock_quantity ? Number(row.stock_quantity) : null,
          low_stock_threshold: row.low_stock_threshold ? Number(row.low_stock_threshold) : null,
          product_id: product?.product_id ?? null, variant_id: variant?.variant_id ?? null,
          expected_version: product?.version ?? null, variant_version: variant?.version ?? null,
          operation: variant || (product && !newVariant) ? "updated" : "created"
        });
      }
      return { rows, errors, warnings, totalRows: lines.length - 1, validRows: rows.length };
    },

    async commitCsv(context, csvContent, requestMeta) {
      requireProductAdmin(context);
      const parsed = asJsonObject(await this.parseCsv(context, csvContent));
      const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
      if (errors.length) throw new HttpError(422, "CSV_VALIDATION_FAILED", "CSV còn dòng lỗi, chưa ghi vào catalog", { errors });
      const rows = Array.isArray(parsed.rows) ? parsed.rows as JsonObject[] : [];
      if (!rows.length) throw validationError("csv", "Không có dòng hợp lệ để nhập");
      const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
      const result = asJsonObject(await repository.importCsv(rows, requestMeta.ipAddress || "0.0.0.0", context.accessToken));
      invalidateCatalogCache();
      return { ...result, warnings, skippedPrices: warnings.length };
    },

    async lowStock(context) {
      requireProductViewer(context);
      await retryDueLowStockAlerts(repository);
      return listLowStockVariants(repository, context.accessToken);
    },

    async listAuditLogs(context, searchParams) {
      requireProductViewer(context);
      const filters = parseAuditFilters(searchParams);
      const payload = await repository.listAuditLogs({
        ...filters,
        limit: clampInteger(searchParams.get("limit"), 50, 1, 100),
        offset: clampInteger(searchParams.get("offset"), 0, 0, 1000000)
      }, context.accessToken);
      return enrichProductAuditLogs(payload);
    },

    async checkSku(context, searchParams) {
      requireProductViewer(context);
      const sku = String(searchParams.get("sku") || "").trim().toUpperCase();
      const excludeProductId = String(searchParams.get("excludeProductId") || "").trim();
      if (excludeProductId) requireUuid(excludeProductId, "excludeProductId");
      if (!SKU_PATTERN.test(sku)) {
        return { sku, available: false, code: "SKU_INVALID", message: SKU_FORMAT_MESSAGE };
      }
      const owner = await repository.findSkuOwner(sku, context.accessToken);
      if (owner && owner.productId !== excludeProductId) {
        return { sku, available: false, code: "SKU_DUPLICATE", message: SKU_DUPLICATE_MESSAGE };
      }
      return { sku, available: true, code: null, message: null };
    },

    async getComboItems(context, productId) {
      requireProductViewer(context);
      requireUuid(productId, "productId");
      return repository.getComboItems(productId, context.accessToken);
    },

    async addComboItem(context, productId, body, requestMeta) {
      requireProductAdmin(context, true);
      requireUuid(productId, "productId");
      const componentProductId = String(body.componentProductId || "").trim();
      const componentVariantId = body.componentVariantId ? String(body.componentVariantId).trim() : null;
      const quantity = Number(body.quantity);
      if (!componentProductId) throw validationError("componentProductId", "componentProductId is required");
      if (!Number.isInteger(quantity) || quantity < 1) throw validationError("quantity", "quantity must be a positive integer");
      return repository.addComboItem(productId, componentProductId, componentVariantId, quantity, context.accessToken);
    },

    async updateComboItem(context, productId, itemId, body, requestMeta) {
      requireProductAdmin(context, true);
      requireUuid(productId, "productId");
      requireUuid(itemId, "itemId");
      const quantity = Number(body.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) throw validationError("quantity", "quantity must be a positive integer");
      return repository.updateComboItem(productId, itemId, quantity, context.accessToken);
    },

    async removeComboItem(context, productId, itemId) {
      requireProductAdmin(context, true);
      requireUuid(productId, "productId");
      requireUuid(itemId, "itemId");
      return repository.removeComboItem(productId, itemId, context.accessToken);
    },

    async analyzeImageQuality(context, body) {
      requireProductViewer(context);
      return analyzeProductImageQuality(asJsonObject(body));
    },

    async enhanceProductImage(context, body) {
      requireProductAdmin(context, true);
      return enhanceProductImageStudio(asJsonObject(body));
    },

    async approveStudioImage(context, body, requestMeta) {
      return new StudioImageApprovalService(new SupabaseEnhancementApprovalRepository()).approve(context, body, requestMeta);
    },

    async optimizeProductSeo(context, body) {
      requireProductAdmin(context, true);
      return generateProductFashionSeo(asJsonObject(body));
    }
  };
}

/**
 * Validate a create-variant request body.
 */
export function validateCreateVariant(body: JsonObject = {}) {
  const sku = String(body.sku || "").trim().toUpperCase();
  if (sku && !SKU_PATTERN.test(sku)) throw validationError("sku", "SKU biến thể không hợp lệ");
  const color = String(body.color || "").trim();
  const size = String(body.size || "").trim().toUpperCase();
  const stockQuantity = Number(body.stockQuantity);
  const lowStockThreshold = Number(body.lowStockThreshold ?? 5);
  if (color.length < 1 || color.length > 80) throw validationError("color", "Màu biến thể bắt buộc, tối đa 80 ký tự");
  if (size.length < 1 || size.length > 30) throw validationError("size", "Size biến thể bắt buộc, tối đa 30 ký tự");
  if (!Number.isInteger(stockQuantity) || stockQuantity < 0) throw validationError("stockQuantity", "Tồn kho phải là số nguyên không âm");
  if (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0) throw validationError("lowStockThreshold", "Ngưỡng cảnh báo tồn phải là số nguyên không âm");
  if (body.colorHex && !/^#[0-9a-f]{6}$/i.test(String(body.colorHex))) throw validationError("colorHex", "Mã màu phải có dạng #RRGGBB");
  return {
    ...(sku ? { sku } : {}),
    color,
    colorHex: body.colorHex ? String(body.colorHex).toUpperCase() : null,
    size,
    sizeMeasurements: body.sizeMeasurements || null,
    stockQuantity,
    lowStockThreshold,
    ipAddress: "0.0.0.0"
  };
}

/**
 * Validate a create-product request body.
 * Validates URL/color associations against initial variants, including the default variant.
 * Hidden drafts may omit images; on-sale products require index 0 as primary.
 */
export function validateCreateProduct(body: JsonObject = {}) {
  const sku = String(body.sku || "").trim().toUpperCase();
  const name = String(body.name || "").trim();
  let slug = String(body.slug || "").trim().toLowerCase();
  if (!SKU_PATTERN.test(sku)) {
    throw validationError("sku", "SKU phải dạng VL-AO001 hoặc VLR-DV006 (chữ in hoa, có gạch ngang)");
  }
  if (name.length < 2 || name.length > 255) {
    throw validationError("name", "Tên sản phẩm bắt buộc, từ 2 đến 255 ký tự");
  }
  if (!slug) {
    slug = slugifyName(name) || slugifyName(sku);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 255) {
    throw validationError("slug", "Slug chỉ gồm chữ thường, số và gạch ngang");
  }
  requireUuid(body.categoryId, "categoryId");
  const basePrice = Number(body.basePrice);
  if (!Number.isFinite(basePrice) || basePrice < 0) {
    throw validationError("basePrice", "Giá gốc phải là số không âm");
  }
  const salePrice = Number(body.salePrice ?? basePrice);
  if (!Number.isFinite(salePrice) || salePrice < 0) {
    throw validationError("salePrice", "Giá bán phải là số không âm");
  }
  const status = body.status || "on_sale";
  if (!["on_sale", "hidden"].includes(status as string)) {
    throw validationError("status", "Sản phẩm mới chỉ được Đang bán hoặc Tạm ẩn");
  }
  const images = validateImageUrls(body.images);
  requirePrimaryImage(images, status);
  const initialStock = Number(body.initialStock ?? 0);
  const lowStockThreshold = Number(body.lowStockThreshold ?? 5);
  const variants = Array.isArray(body.variants) && body.variants.length > 0
    ? body.variants.map((variant) => validateCreateVariant(asJsonObject(variant)))
    : [validateCreateVariant({
      color: "Mặc định", colorHex: "#FFFFFF", size: "F",
      stockQuantity: Number.isInteger(initialStock) && initialStock >= 0 ? initialStock : 0,
      lowStockThreshold: Number.isInteger(lowStockThreshold) && lowStockThreshold >= 0 ? lowStockThreshold : 5
    })];
  const variantSkus = variants.map((variant) => variant.sku).filter((value): value is string => Boolean(value));
  if (new Set(variantSkus).size !== variantSkus.length) throw validationError("sku", SKU_DUPLICATE_MESSAGE);
  const variantKeys = variants.map((variant) => `${variant.color.toLowerCase()}|${variant.size}`);
  if (new Set(variantKeys).size !== variantKeys.length) throw validationError("variants", "Mỗi tổ hợp màu và size chỉ được khai báo một lần");
  const imageColors = validateImageColorLinks(body.imageColors === undefined ? {} : body.imageColors, images, variants.map((variant) => variant.color));
  return {
    sku,
    name,
    slug,
    description: optionalText(body.description, 5000),
    categoryId: body.categoryId,
    brand: optionalText(body.brand, 100),
    basePrice,
    salePrice,
    images,
    imageColors,
    variants,
    styleTags: validateStringArray(body.styleTags, "styleTags", 30, 100),
    colorTone: body.colorTone || null,
    occasions: validateStringArray(body.occasions, "occasions", 20, 100),
    suitableBodyShapes: validateStringArray(body.suitableBodyShapes, "suitableBodyShapes", 20, 100),
    status,
    isFeatured: Boolean(body.isFeatured),
    isCombo: Boolean(body.isCombo),
    collection: optionalText(body.collection, 100),
    seoTitle: optionalText(body.seoTitle, 255),
    seoDescription: optionalText(body.seoDescription, 500),
    expectedVersion: requireVersion(body.expectedVersion),
    ipAddress: "0.0.0.0"
  };
}

/**
 * Validate an update-product request body.
 * Omitting imageColors preserves associations; an explicit empty map marks all images common.
 * The service validates exact variant colors and prunes removed URLs against the stored product.
 */
export function validateUpdateProduct(body: JsonObject = {}) {
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length < 2 || body.name.trim().length > 255)) {
    throw validationError("name", "Tên sản phẩm bắt buộc, từ 2 đến 255 ký tự");
  }
  if (body.categoryId !== undefined) requireUuid(body.categoryId, "categoryId");
  if (body.status !== undefined) throw validationError("status", "Hãy dùng chức năng đổi trạng thái để thay đổi trạng thái sản phẩm");
  if (body.basePrice !== undefined || body.salePrice !== undefined) {
    throw validationError("price", "Hãy dùng chức năng điều chỉnh giá để thay đổi giá sản phẩm");
  }
  const input = {
    name: body.name !== undefined ? (body.name as string).trim() : undefined,
    description: body.description !== undefined ? optionalText(body.description, 5000) : undefined,
    categoryId: body.categoryId || undefined,
    brand: body.brand !== undefined ? optionalText(body.brand, 100) : undefined,
    basePrice: undefined,
    salePrice: undefined,
    images: body.images !== undefined ? validateImageUrls(body.images) : undefined,
    imageColors: body.imageColors !== undefined ? validateImageColorMap(body.imageColors) : undefined,
    styleTags: body.styleTags !== undefined ? validateStringArray(body.styleTags, "styleTags", 30, 100) : undefined,
    colorTone: body.colorTone !== undefined ? body.colorTone : undefined,
    occasions: body.occasions !== undefined ? validateStringArray(body.occasions, "occasions", 20, 100) : undefined,
    suitableBodyShapes: body.suitableBodyShapes !== undefined ? validateStringArray(body.suitableBodyShapes, "suitableBodyShapes", 20, 100) : undefined,
    isFeatured: body.isFeatured !== undefined ? Boolean(body.isFeatured) : undefined,
    isCombo: body.isCombo !== undefined ? Boolean(body.isCombo) : undefined,
    collection: body.collection !== undefined ? optionalText(body.collection, 100) : undefined,
    seoTitle: body.seoTitle !== undefined ? optionalText(body.seoTitle, 255) : undefined,
    seoDescription: body.seoDescription !== undefined ? optionalText(body.seoDescription, 500) : undefined,
    expectedVersion: requireVersion(body.expectedVersion),
    ipAddress: "0.0.0.0"
  };
  const changedFields = Object.entries(input).filter(([key, value]) => !["expectedVersion", "ipAddress"].includes(key) && value !== undefined);
  if (!changedFields.length) throw validationError("body", "Cần ít nhất một thông tin sản phẩm để cập nhật");
  return input;
}

/**
 * Validate a product status-change request body.
 */
export function validateStatusChange(body: JsonObject = {}) {
  if (!PRODUCT_STATUSES.includes(body.status as string)) {
    throw validationError("status", "Trạng thái không hợp lệ; chọn Đang bán, Tạm ẩn, Hết hàng hoặc Ngừng kinh doanh");
  }
  return {
    status: body.status as string,
    reason: requireReason(body.reason, "reason"),
    expectedVersion: requireVersion(body.expectedVersion),
    ipAddress: "0.0.0.0"
  };
}

/**
 * Validate a stock-delta request body.
 */
export function validateStockUpdate(body: JsonObject = {}) {
  const delta = Number(body.delta);
  if (!Number.isInteger(delta) || delta === 0) {
    throw validationError("delta", "Số lượng điều chỉnh phải là số nguyên khác 0");
  }
  return {
    delta,
    reason: requireReason(body.reason, "reason"),
    expectedVersion: requireVersion(body.expectedVersion),
    ipAddress: "0.0.0.0"
  };
}

function requireProductViewer(context: AuthContext | undefined): asserts context is AuthContext {
  if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Cần đăng nhập để tiếp tục");
  if (!context.isAdmin || !context.profile?.is_active) {
    throw new HttpError(403, "ADMIN_REQUIRED", "Cần tài khoản quản trị đang hoạt động");
  }
  if (!PRODUCT_VIEWER_ROLES.includes(context.roleCode)) {
    throw new HttpError(403, "RBAC_DENIED", "Vai trò quản trị này không được xem sản phẩm");
  }
}

function requireProductAdmin(context: AuthContext | undefined, isComboOperation = false): asserts context is AuthContext {
  requireProductViewer(context);
  const allowedRoles = isComboOperation ? [...PRODUCT_ADMIN_ROLES, "admin_operator_gia_km"] : PRODUCT_ADMIN_ROLES;
  if (!allowedRoles.includes(context.roleCode)) {
    throw new HttpError(403, "RBAC_DENIED", "Vai trò quản trị này không được chỉnh sửa sản phẩm");
  }
}

function parseListFilters(searchParams: URLSearchParams): JsonObject {
  const status = searchParams.get("status") || "";
  if (status && !PRODUCT_STATUSES.includes(status)) {
    throw validationError("status", "Bộ lọc trạng thái không hợp lệ");
  }
  const orderInput = searchParams.get("order") || "updated_at.desc";
  const allowedOrders = [
    "created_at.desc", "created_at.asc", "name.asc", "name.desc",
    "sale_price.asc", "sale_price.desc", "updated_at.desc"
  ];
  const categoryId = searchParams.get("categoryId") || "";
  if (categoryId) requireUuid(categoryId, "categoryId");
  const minPrice = parseOptionalPrice(searchParams.get("minPrice"), "minPrice");
  const maxPrice = parseOptionalPrice(searchParams.get("maxPrice"), "maxPrice");
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw validationError("price", "Giá tối thiểu không được lớn hơn giá tối đa");
  }
  return {
    q: String(searchParams.get("q") || "").trim().slice(0, 100),
    status: status || undefined,
    categoryId: categoryId || undefined,
    isCombo: searchParams.get("isCombo") === "true" ? true : searchParams.get("isCombo") === "false" ? false : undefined,
    isFeatured: searchParams.get("isFeatured") === "true" ? true : searchParams.get("isFeatured") === "false" ? false : undefined,
    lowStock: searchParams.get("lowStock") === "true" || searchParams.get("lowStock") === "1" ? true : undefined,
    minPrice,
    maxPrice,
    limit: clampInteger(searchParams.get("limit"), 20, 1, 1000),
    offset: clampInteger(searchParams.get("offset"), 0, 0, 1000000),
    order: allowedOrders.includes(orderInput) ? orderInput : "updated_at.desc"
  };
}

/** SKU pattern hint shown when the typed SKU is malformed. */
const SKU_FORMAT_MESSAGE = "SKU phải dạng VL-AO001 hoặc VLR-DV006 (chữ in hoa, có gạch ngang)";

/** Format an amount as Vietnamese dong for CSV warnings, e.g. `250.000đ`. */
function formatVnd(value: number): string {
  return `${Math.round(value).toLocaleString("vi-VN")}đ`;
}

/**
 * Reject a new product when any of its product/variant SKUs already exists anywhere in the catalog.
 * Throws HTTP 409 SKU_DUPLICATE with the Vietnamese uniqueness message; the database constraint remains the last guard.
 */
async function assertSkusAvailable(
  repository: ProductRepository,
  context: AuthContext,
  skus: string[]
): Promise<void> {
  if (typeof repository.findSkuOwner !== "function") return;
  for (const sku of new Set(skus.map((value) => value.trim().toUpperCase()).filter(Boolean))) {
    if (await repository.findSkuOwner(sku, context.accessToken)) {
      throw new HttpError(409, "SKU_DUPLICATE", SKU_DUPLICATE_MESSAGE);
    }
  }
}

interface AuditFilters {
  targetId?: string;
  fromDate?: string;
  toDate?: string;
  product?: string;
  actionType?: ProductAuditActionType;
  user?: string;
}

const AUDIT_ACTION_ALIASES: Record<string, ProductAuditActionType> = {
  CHANGE_STATUS: "UPDATE_STATUS",
  UPDATE_STATUS: "UPDATE_STATUS",
  STATUS: "UPDATE_STATUS",
  UPDATE_STOCK: "UPDATE_STOCK",
  STOCK: "UPDATE_STOCK",
  CREATE: "CREATE",
  UPDATE: "UPDATE"
};

/**
 * Parse product audit-log filters. `from`/`to` are inclusive calendar days in Asia/Ho_Chi_Minh;
 * legacy `date` (single day), `q` (product) and `action` are mapped onto the same filters.
 */
function parseAuditFilters(searchParams: URLSearchParams): AuditFilters {
  const targetId = String(searchParams.get("targetId") || "").trim();
  if (targetId) requireUuid(targetId, "targetId");
  const legacyDate = String(searchParams.get("date") || "").trim();
  const from = String(searchParams.get("from") || legacyDate).trim();
  const to = String(searchParams.get("to") || legacyDate).trim();
  for (const [field, value] of [["from", from], ["to", to]] as const) {
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00+07:00`)))) {
      throw validationError(field, "Ngày không hợp lệ, dùng định dạng YYYY-MM-DD");
    }
  }
  if (from && to && from > to) throw validationError("to", "Ngày kết thúc phải sau hoặc bằng ngày bắt đầu");
  const rawAction = String(searchParams.get("actionType") || searchParams.get("action") || "").trim();
  const actionType = rawAction ? AUDIT_ACTION_ALIASES[rawAction.toUpperCase().replace(/[\s-]+/g, "_")] : undefined;
  if (rawAction && !actionType) {
    throw validationError("actionType", `Loại hành động không hợp lệ; chọn ${PRODUCT_AUDIT_ACTION_TYPES.join(", ")}`);
  }
  return {
    targetId: targetId || undefined,
    fromDate: from ? `${from}T00:00:00+07:00` : undefined,
    toDate: to ? `${to}T23:59:59.999+07:00` : undefined,
    product: String(searchParams.get("product") || searchParams.get("q") || "").trim().slice(0, 100) || undefined,
    actionType,
    user: String(searchParams.get("user") || "").trim().slice(0, 100) || undefined
  };
}

function parseCsvLines(content: unknown): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  const input = String(content || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw validationError("csv", "CSV contains an unclosed quoted field");
  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function parseCsvRow(headers: string[], values: string[]): Record<string, string> {
  const row: Record<string, string> = {};
  headers.forEach((header, i) => { row[header] = (values[i] || "").trim(); });
  return row;
}

function requireUuid(value: unknown, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""))) {
    throw validationError(field, field === "categoryId" ? "Chọn danh mục hợp lệ" : field === "variantId" ? "Chọn biến thể hợp lệ" : `${field} phải là UUID`);
  }
}

function requireVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw validationError("expectedVersion", "Phiên bản dữ liệu không hợp lệ; tải lại trang rồi thử lại");
  }
  return version;
}

function optionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (text.length > maxLength) throw validationError("field", `Nội dung tối đa ${maxLength} ký tự`);
  return text || null;
}

function requireReason(value: unknown, field: string): string {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (text.length < 10 || text.length > 500) {
    throw validationError(field, "Lý do phải từ 10 đến 500 ký tự");
  }
  return text;
}

function validateStringArray(value: unknown, field: string, maxItems: number, maxItemLength: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw validationError(field, field === "images" ? `Sản phẩm chỉ được có tối đa ${maxItems} ảnh` : `${field} chỉ được tối đa ${maxItems} mục`);
  }
  return value.map((item) => {
    const text = String(item || "").trim();
    if (!text || text.length > maxItemLength) {
      throw validationError(field, `${field} có mục không hợp lệ`);
    }
    return text;
  });
}

function slugifyName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function validateImageUrls(value: unknown): string[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  const images = validateStringArray(value, "images", 20, 2048);
  if (new Set(images).size !== images.length) {
    throw validationError("images", "Mỗi ảnh chỉ được dùng một lần; ảnh đầu tiên là ảnh chính");
  }
  for (const image of images) {
    if (image.startsWith("/") && !image.startsWith("//")) {
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(image);
    } catch {
      throw validationError("images", "Ảnh phải là URL https hoặc đường dẫn /assets/...");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw validationError("images", "Ảnh phải dùng http hoặc https. Có thể để trống nếu chưa có storage.");
    }
  }
  return images;
}

function requirePrimaryImage(images: string[], status: unknown): void {
  if (status === "on_sale" && images.length === 0) {
    throw validationError("images", "Sản phẩm đang bán cần ít nhất một ảnh chính (ảnh đầu tiên); hãy thêm ảnh trước khi chuyển sang Đang bán");
  }
}

function validateImageColorMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("imageColors", "Liên kết ảnh và màu phải là bản đồ từ URL ảnh sang màu biến thể");
  }
  const entries = Object.entries(value);
  if (entries.some(([, color]) => typeof color !== "string" || !color.trim())) {
    throw validationError("imageColors", "Mỗi ảnh liên kết phải gắn với một màu biến thể không trống");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function validateImageColorLinks(value: unknown, images: string[], colors: string[]): Record<string, string> {
  const mapping = validateImageColorMap(value);
  for (const [url, color] of Object.entries(mapping)) {
    if (!images.includes(url) || !colors.includes(color)) {
      throw validationError("imageColors", "Mỗi liên kết phải trỏ tới một ảnh của sản phẩm và đúng tên màu của một biến thể");
    }
  }
  return mapping;
}

async function syncProductStockStatus(
  repository: ProductRepository,
  context: AuthContext,
  productId: string,
  reason: string,
  ipAddress: string
): Promise<void> {
  const [product, variants] = await Promise.all([
    repository.findById(productId, context.accessToken),
    repository.listVariants(productId, context.accessToken)
  ]);
  if (!product) return;
  const totalStock = (variants.rows || variants || []).reduce((sum: number, variant: JsonObject) => sum + Number(variant.stock_quantity || 0), 0);
  if (totalStock <= 0 && product.status === "on_sale") {
    await repository.changeStatus(productId, { status: "out_of_stock", reason, expectedVersion: product.version, ipAddress }, context.accessToken);
  }
  if (totalStock > 0 && product.status === "out_of_stock") {
    await repository.changeStatus(productId, { status: "on_sale", reason, expectedVersion: product.version, ipAddress }, context.accessToken);
  }
}

/** Outcome of the low-stock check after a stock write; surfaced on screen regardless of email delivery. */
export interface LowStockAlert {
  productId: string;
  variantId: string;
  productName: string;
  sku: string;
  color: string;
  size: string;
  stock: number;
  threshold: number;
  /** True when the alert email reached the outbox for every admin recipient. */
  emailQueued: boolean;
  /** True when a failed email was persisted in `low_stock_alert_retry` for a later retry. */
  retryRecorded: boolean;
  message: string;
}

interface LowStockTarget {
  productId: string;
  variantId: string;
  productName: string;
  sku: string;
  color: string;
  size: string;
  stock: number;
  threshold: number;
}

/** Queue one low-stock email per active admin; throws on the first outbox failure so the caller can record a retry. */
async function queueLowStockEmails(target: LowStockTarget): Promise<void> {
  const adminUsers = await selectRows("users", { select: "user_id,email", role: "eq.admin", is_active: "eq.true" }, { useAnonKey: false });
  for (const admin of adminUsers.rows || []) {
    if (!admin.email) continue;
    await insertRow("email_outbox", {
      recipient: admin.email,
      template_code: "low_stock_alert",
      subject: `[Velura Alert] Sản phẩm ${target.productName} sắp hết hàng!`,
      body: `Cảnh báo: Sản phẩm "${target.productName}" (SKU: ${target.sku}), biến thể "${target.color} / ${target.size}" hiện chỉ còn ${target.stock} sản phẩm trong kho (dưới ngưỡng tối thiểu là ${target.threshold}).\nVui lòng bổ sung tồn kho kịp thời.`,
      related_user_id: admin.user_id,
      metadata: { productId: target.productId, variantId: target.variantId, stock: target.stock, threshold: target.threshold }
    });
  }
}

/**
 * After a stock write: when a variant is at or below its own threshold, return the on-screen alert and queue the
 * admin email. A failed email never hides the alert: it is persisted as a retry record and `emailQueued` is false.
 * Dropping below the threshold is a normal adjustment and is never rejected.
 */
async function checkAndAlertLowStock(
  repository: ProductRepository,
  context: AuthContext,
  productId: string,
  variantId: string
): Promise<LowStockAlert | null> {
  let target: LowStockTarget;
  try {
    const [product, variants] = await Promise.all([
      repository.findById(productId, context.accessToken),
      repository.listVariants(productId, context.accessToken)
    ]);
    if (!product) return null;
    const variant = (variants.rows || variants || []).find((v: JsonObject) => v.variant_id === variantId);
    if (!variant) return null;
    target = {
      productId, variantId,
      productName: asString(product.name), sku: asString(product.sku),
      color: asString(variant.color), size: asString(variant.size),
      stock: Number(variant.stock_quantity || 0), threshold: Number(variant.low_stock_threshold ?? 5)
    };
  } catch (err: unknown) {
    console.error("[Low Stock Alert] Could not read stock for the alert:", errorMessage(err) || err);
    return null;
  }
  if (target.stock > target.threshold) return null;

  console.log(`[Low Stock Alert] Product "${target.productName}" (${target.sku}), variant "${target.color}/${target.size}" is below threshold. Stock: ${target.stock}, Threshold: ${target.threshold}`);
  const label = `${target.productName} (${target.color} / ${target.size})`;
  try {
    await queueLowStockEmails(target);
    return { ...target, emailQueued: true, retryRecorded: false,
      message: `Cảnh báo tồn kho thấp: ${label} còn ${target.stock}, ngưỡng tối thiểu ${target.threshold}.` };
  } catch (err: unknown) {
    const reason = errorMessage(err) || "Không gửi được email cảnh báo";
    console.error("[Low Stock Alert] Failed to queue warning emails:", reason);
    const retryRecorded = typeof repository.recordLowStockAlertFailure === "function"
      && await repository.recordLowStockAlertFailure({ productId, variantId, stock: target.stock, threshold: target.threshold, error: reason });
    return { ...target, emailQueued: false, retryRecorded,
      message: `Cảnh báo tồn kho thấp: ${label} còn ${target.stock}, ngưỡng tối thiểu ${target.threshold}. Email cảnh báo chưa gửi được${retryRecorded ? " và đã lưu để thử lại" : ""}.` };
  }
}

/** Re-queue due low-stock alert retries; failures stay recorded with their error and attempt count. */
async function retryDueLowStockAlerts(repository: ProductRepository): Promise<void> {
  if (typeof repository.listDueLowStockAlertRetries !== "function") return;
  try {
    for (const retry of await repository.listDueLowStockAlertRetries(5)) {
      const productId = asString(retry.product_id);
      const variantId = asString(retry.variant_id);
      const stock = Number(retry.stock_quantity);
      const threshold = Number(retry.low_stock_threshold);
      try {
        const [product, variant] = await Promise.all([
          selectOne("product", { select: "name,sku", product_id: `eq.${productId}` }, { useAnonKey: false }),
          selectOne("variant", { select: "color,size", variant_id: `eq.${variantId}` }, { useAnonKey: false })
        ]);
        await queueLowStockEmails({
          productId, variantId, stock, threshold,
          productName: asString(product?.name), sku: asString(product?.sku),
          color: asString(variant?.color), size: asString(variant?.size)
        });
        await repository.completeLowStockAlertRetry(asString(retry.retry_id));
      } catch (err: unknown) {
        await repository.recordLowStockAlertFailure({ productId, variantId, stock, threshold, error: errorMessage(err) || "Không gửi được email cảnh báo" });
      }
    }
  } catch (err: unknown) {
    console.error("[Low Stock Alert] Retry pass failed:", errorMessage(err) || err);
  }
}

/** Variants at/below threshold joined with product name/SKU/status, lowest stock first. */
async function listLowStockVariants(repository: ProductRepository, accessToken: string | null): Promise<JsonObject[]> {
  const payload = await repository.lowStockCount(accessToken);
  const variants = (Array.isArray(payload) ? payload : asRows(payload)).map((row) => asJsonObject(row));
  const productIds = uniqueIds(variants.map((row) => asString(row.product_id)));
  const products = typeof repository.findProductsByIds === "function" && productIds.length
    ? await repository.findProductsByIds(productIds, accessToken)
    : { rows: [] as JsonObject[] };
  const byId = new Map(products.rows.map((product) => [asString(product.product_id), product] as const));
  return variants.map((row) => {
    const product = byId.get(asString(row.product_id));
    const stock = Number(row.stock_quantity || 0);
    const threshold = Number(row.low_stock_threshold || 0);
    return {
      ...row,
      product_name: asString(product?.name) || null,
      product_sku: asString(product?.sku) || null,
      product_status: asString(product?.status) || null,
      shortage: Math.max(0, threshold - stock),
      out_of_stock: stock <= 0
    };
  });
}

function asRows(payload: unknown): unknown[] {
  const rows = (payload as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

function parseOptionalPrice(value: string | null, field: string): number | undefined {
  if (value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw validationError(field, `${field} phải là số không âm`);
  }
  return number;
}

/**
 * Adds display labels to RPC audit rows: actor (name + email), product, Vietnamese action type, before/after summary
 * and the operator reason stored with status/stock changes. Filtering already happened in SQL.
 */
function enrichProductAuditLogs(
  payload: { rows: JsonObject[]; count: number | undefined } | JsonObject[] | unknown
): { rows: JsonObject[]; count: number | undefined } {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { rows?: JsonObject[] })?.rows)
      ? (payload as { rows: JsonObject[] }).rows
      : [];
  const count = Array.isArray(payload)
    ? payload.length
    : (payload as { count?: number | undefined })?.count;

  const enriched = rows.map((row) => {
    const oldValue = asJsonObject(row.old_value) || {};
    const newValue = asJsonObject(row.new_value) || {};
    const actionType = asString(row.action_type) || derivedAuditActionType(asString(row.action), oldValue, newValue);
    const product = { sku: row.product_sku, name: row.product_name } as JsonObject;
    const actorName = asString(row.actor_name) || "";
    const actorEmail = asString(row.actor_email) || "";
    const actorRole = asString(row.actor_role) || "";
    const actorFallback = asString(row.actor_id) || "Hệ thống";
    const reason = asString(newValue.reason) || asString(oldValue.reason) || "";

    return {
      ...row,
      action_type: actionType,
      actor_name: actorName || actorEmail || actorFallback,
      actor_email: actorEmail || null,
      actor_label: actorName && actorEmail ? `${actorName} (${actorEmail})` : actorName || actorEmail || actorFallback,
      actor_role_label: productAuditRoleLabel(actorRole),
      target_label: productAuditTargetLabel(product, oldValue, newValue, asString(row.target_id)),
      action_label: productAuditActionLabel(actionType, newValue),
      change_summary: productAuditChangeSummary(oldValue, newValue, asString(row.action)),
      reason: reason || null,
      result: asString(row.result) || "Thành công"
    };
  });

  return { rows: enriched, count: count ?? enriched.length };
}

/** Classify a stored audit row the same way as `admin_list_product_audit_logs` when the RPC did not supply `action_type`. */
function derivedAuditActionType(action: string, oldValue: JsonObject, newValue: JsonObject): ProductAuditActionType {
  if (action.toLowerCase() === "create") return "CREATE";
  if (oldValue.status !== undefined && newValue.status !== undefined && oldValue.status !== newValue.status) return "UPDATE_STATUS";
  if (oldValue.stock_quantity !== undefined && newValue.stock_quantity !== undefined && oldValue.stock_quantity !== newValue.stock_quantity) {
    return "UPDATE_STOCK";
  }
  return "UPDATE";
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function productAuditRoleLabel(role: string): string {
  const map: Record<string, string> = {
    admin_super: "Super Admin",
    super_admin: "Super Admin",
    admin_operator_sanpham: "Quản lý sản phẩm",
    admin_operator_donhang: "Quản lý đơn hàng",
    admin_operator_gia_km: "Quản lý giá / KM",
    admin_operator_danhgia_review: "Quản lý đánh giá",
    admin_operator_cskh_dt: "CSKH / Đổi trả"
  };
  return map[role] || role || "—";
}

function productAuditActionLabel(actionType: string, newValue: JsonObject): string {
  if (actionType === "CREATE") return newValue.color || newValue.size ? "Thêm biến thể" : "Thêm sản phẩm";
  if (actionType === "UPDATE_STATUS") return "Đổi trạng thái";
  if (actionType === "UPDATE_STOCK") return "Điều chỉnh tồn kho";
  if (actionType === "UPDATE") return "Cập nhật sản phẩm";
  return actionType || "—";
}

function productAuditTargetLabel(
  product: JsonObject | undefined,
  oldValue: JsonObject,
  newValue: JsonObject,
  targetId: string | null
): string {
  const sku = asString(product?.sku) || asString(newValue.sku) || asString(oldValue.sku) || "";
  const name = asString(product?.name) || asString(newValue.name) || asString(oldValue.name) || "";
  if (sku && name) return `${sku} — ${name}`;
  if (sku) return sku;
  if (name) return name;

  const color = asString(newValue.color) || asString(oldValue.color) || "";
  const size = asString(newValue.size) || asString(oldValue.size) || "";
  if (color || size) {
    const productRef = asString(newValue.product_id) || asString(oldValue.product_id) || "";
    const variantLabel = [color, size].filter(Boolean).join(" / ");
    return productRef ? `Biến thể ${variantLabel}` : variantLabel;
  }

  return targetId || "—";
}

function productAuditChangeSummary(
  oldValue: JsonObject,
  newValue: JsonObject,
  action: string | null
): string {
  const hasOld = Object.keys(oldValue).length > 0;
  const hasNew = Object.keys(newValue).length > 0;
  if (!hasOld && !hasNew) return "—";

  if (String(action || "").toLowerCase() === "create") {
    const sku = asString(newValue.sku) || "";
    const name = asString(newValue.name) || "";
    if (sku || name) return `— → ${[sku, name].filter(Boolean).join(" · ")}`;
    const color = asString(newValue.color) || "";
    const size = asString(newValue.size) || "";
    const stock = newValue.stock_quantity;
    if (color || size || stock !== undefined) {
      return `— → ${[color, size].filter(Boolean).join("/")} tồn ${stock ?? 0}`;
    }
    return "— → đã tạo";
  }

  if (oldValue.status !== undefined && newValue.status !== undefined && oldValue.status !== newValue.status) {
    return `${statusVi(asString(oldValue.status))} → ${statusVi(asString(newValue.status))}`;
  }

  if (
    oldValue.stock_quantity !== undefined &&
    newValue.stock_quantity !== undefined &&
    oldValue.stock_quantity !== newValue.stock_quantity
  ) {
    return `Tồn ${oldValue.stock_quantity} → ${newValue.stock_quantity}`;
  }

  const parts: string[] = [];
  for (const key of ["name", "sku", "sale_price", "base_price", "collection", "status"] as const) {
    if (oldValue[key] !== undefined && newValue[key] !== undefined && oldValue[key] !== newValue[key]) {
      parts.push(`${key}: ${formatAuditScalar(oldValue[key])} → ${formatAuditScalar(newValue[key])}`);
    }
  }
  if (parts.length) return parts.slice(0, 3).join("; ");
  if (hasOld && hasNew) return "Đã cập nhật";
  if (hasNew) return "— → có dữ liệu mới";
  return "có → —";
}

function statusVi(status: string | null): string {
  const map: Record<string, string> = {
    on_sale: "Đang bán",
    hidden: "Tạm ẩn",
    out_of_stock: "Hết hàng",
    discontinued: "Ngừng kinh doanh"
  };
  return map[String(status || "")] || status || "—";
}

function formatAuditScalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "có" : "không";
  return String(value);
}

function clampInteger(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  const number = Number(raw);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function validationError(field: string, message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { [field]: [message] });
}
