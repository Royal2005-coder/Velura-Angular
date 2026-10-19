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
  STATUS_TRANSITIONS,
  SKU_PATTERN,
  CSV_MAX_ROWS,
  CSV_REQUIRED_COLUMNS
} from "./product-constants.js";
import type { ProductRepository } from "./product-repository.js";
import { invalidateCatalogCache } from "../user/products.js";
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
  /** Preview product/variant SKU rows; every duplicate and existing-price change is a blocking row error. */
  parseCsv(context: AuthContext | undefined, csvContent: unknown): Promise<unknown>;
  /** Revalidate raw CSV and atomically persist all rows; existing prices are never updated. */
  commitCsv(context: AuthContext | undefined, csvContent: unknown, requestMeta: RequestMeta): Promise<unknown>;
  lowStock(context: AuthContext | undefined): Promise<unknown>;
  listAuditLogs(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<unknown>;
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
  optimizeProductSeo(context: AuthContext | undefined, body: JsonObject): Promise<unknown>;
}

/**
 * Create the admin product application service.
 */
export function createProductService({ repository }: { repository: ProductRepository }): ProductService {
  if (!repository) throw new TypeError("repository is required");

  // Run an asynchronous alignment of stock status on startup with a brief delay
  setTimeout(async () => {
    try {
      if (
        !repository
        || typeof repository.list !== "function"
        || typeof repository.listVariants !== "function"
        || typeof repository.changeStatus !== "function"
      ) {
        return;
      }
      const products = await repository.list({ limit: 1000 }, null);
      const rows = products?.rows || (Array.isArray(products) ? products : []);
      for (const product of rows) {
        if (product.status === "on_sale" || product.status === "out_of_stock") {
          const variants = await repository.listVariants(product.product_id as string, null);
          const list = variants?.rows || (Array.isArray(variants) ? variants : []);
          const totalStock = list.reduce((sum: number, v: JsonObject) => sum + Number(v.stock_quantity || 0), 0);
          if (totalStock <= 0 && product.status === "on_sale") {
            await repository.changeStatus(product.product_id as string, {
              status: "out_of_stock",
              reason: "Đồng bộ tồn kho hệ thống (hết hàng)",
              expectedVersion: product.version,
              ipAddress: "127.0.0.1"
            }, null);
            console.log(`[Startup Sync] Product ${product.sku} status aligned to out_of_stock (stock: 0)`);
          } else if (totalStock > 0 && product.status === "out_of_stock") {
            await repository.changeStatus(product.product_id as string, {
              status: "on_sale",
              reason: "Đồng bộ tồn kho hệ thống (còn hàng)",
              expectedVersion: product.version,
              ipAddress: "127.0.0.1"
            }, null);
            console.log(`[Startup Sync] Product ${product.sku} status aligned to on_sale (stock: ${totalStock})`);
          }
        }
      }
    } catch (err: unknown) {
      console.error("[Startup Sync Error] Failed to align stock status:", errorMessage(err));
    }
  }, 1000);

  return {
    async list(context, searchParams) {
      requireProductViewer(context);
      return repository.list(parseListFilters(searchParams), context.accessToken);
    },

    async get(context, productId) {
      requireProductViewer(context);
      requireUuid(productId, "productId");
      const product = await repository.findById(productId, context.accessToken);
      if (!product) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product was not found");
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
      if (!current) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product was not found");
      requireProductAdmin(context, current.is_combo === true);
      const input = validateStatusChange(body);
      if (current.status === input.status || !STATUS_TRANSITIONS[current.status as string]?.includes(input.status)) {
        throw validationError("status", `Cannot change status from ${current.status} to ${input.status}`);
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
      if (!current) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product was not found");
      requireProductAdmin(context, current.is_combo === true);
      requireUuid(body?.variantId, "variantId");

      const delta = Number(body?.delta || 0);
      const lowStockThreshold = body?.lowStockThreshold !== undefined ? Number(body.lowStockThreshold) : undefined;
      const reason = String(body?.reason || "").trim();
      const ipAddress = requestMeta.ipAddress || "0.0.0.0";

      if (delta === 0 && lowStockThreshold === undefined) {
        throw validationError("delta", "Either delta must be non-zero or lowStockThreshold must be provided");
      }
      if (reason.length < 10) {
        throw validationError("reason", "Reason must be at least 10 characters");
      }

      let result: unknown = { success: true };
      if (delta !== 0) {
        const input = validateStockUpdate(body);
        input.ipAddress = ipAddress;
        result = await repository.updateStock(productId, body.variantId as string, input, context.accessToken);
      }

      if (lowStockThreshold !== undefined) {
        if (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0) {
          throw validationError("lowStockThreshold", "Threshold must be a non-negative integer");
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
      await checkAndAlertLowStock(repository, context, productId, body.variantId as string);
      return result;
    },

    async bulkUpdateStock(context, productId, body, requestMeta) {
      requireUuid(productId, "productId");
      const current = await repository.findById(productId, context?.accessToken ?? null);
      if (!current) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product was not found");
      requireProductAdmin(context, current.is_combo === true);

      if (!body || !Array.isArray(body.updates)) {
        throw validationError("updates", "updates must be an array");
      }
      const reason = String(body.reason || "").trim();
      if (reason.length < 10) {
        throw validationError("reason", "Reason must be at least 10 characters");
      }

      const ipAddress = requestMeta.ipAddress || "0.0.0.0";
      const results: JsonObject[] = [];
      const updates = body.updates as JsonObject[];

      for (const update of updates) {
        requireUuid(update.variantId, "variantId");
        const delta = Number(update.delta || 0);
        const lowStockThreshold = update.lowStockThreshold !== undefined ? Number(update.lowStockThreshold) : undefined;
        
        if (!Number.isInteger(delta)) {
          throw validationError("delta", "Delta must be an integer");
        }
        if (lowStockThreshold !== undefined && (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0)) {
          throw validationError("lowStockThreshold", "Threshold must be a non-negative integer");
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

      for (const update of updates) {
        await checkAndAlertLowStock(repository, context, productId, update.variantId as string);
      }

      return { success: true, results };
    },

    async createVariant(context, productId, body, requestMeta) {
      requireUuid(productId, "productId");
      const current = await repository.findById(productId, context?.accessToken ?? null);
      if (!current) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product was not found");
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
      if (lines.length === 0) throw validationError("csv", "CSV file is empty");
      if (lines.length - 1 > CSV_MAX_ROWS) throw validationError("csv", `CSV cannot exceed ${CSV_MAX_ROWS} rows`);
      const headers = lines[0].map((header) => header.trim().toLowerCase());
      const missing = CSV_REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
      if (missing.length) throw validationError("csv", `Missing required columns: ${missing.join(", ")}`);
      const errors: JsonObject[] = [];
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
        if ((skuRows.get(sku)?.length || 0) > 1) reject("sku", "SKU bị lặp trong file (không phân biệt hoa/thường và khoảng trắng)");
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
        if (product) {
          if (Number.isFinite(basePrice) && basePrice !== Number(product.base_price)) reject("base_price", "CSV không được đổi giá hiện có; sử dụng quy trình quản lý giá");
          if (salePrice !== null && Number.isFinite(salePrice) && salePrice !== Number(product.sale_price)) reject("sale_price", "CSV không được đổi giá hiện có; sử dụng quy trình quản lý giá");
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
          base_price: basePrice, sale_price: salePrice,
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
      return { rows, errors, totalRows: lines.length - 1, validRows: rows.length };
    },

    async commitCsv(context, csvContent, requestMeta) {
      requireProductAdmin(context);
      const parsed = asJsonObject(await this.parseCsv(context, csvContent));
      const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
      if (errors.length) throw new HttpError(422, "CSV_VALIDATION_FAILED", "CSV còn dòng lỗi, chưa ghi vào catalog", { errors });
      const rows = Array.isArray(parsed.rows) ? parsed.rows as JsonObject[] : [];
      if (!rows.length) throw validationError("csv", "Không có dòng hợp lệ để nhập");
      const result = await repository.importCsv(rows, requestMeta.ipAddress || "0.0.0.0", context.accessToken);
      invalidateCatalogCache();
      return result;
    },

    async lowStock(context) {
      requireProductViewer(context);
      const items = await repository.lowStockCount(context.accessToken);
      return items;
    },

    async listAuditLogs(context, searchParams) {
      requireProductViewer(context);
      const targetId = searchParams.get("targetId") || "";
      if (targetId) requireUuid(targetId, "targetId");
      const date = String(searchParams.get("date") || "").trim();
      const q = String(searchParams.get("q") || "").trim();
      const action = String(searchParams.get("action") || "").trim();

      let fromDate: string | undefined;
      let toDate: string | undefined;
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        fromDate = `${date}T00:00:00.000Z`;
        toDate = `${date}T23:59:59.999Z`;
      }

      let matchedTargetIds: string[] | undefined;
      if (q && !targetId) {
        try {
          const productHits = await selectRows("product", {
            select: "product_id",
            or: `(name.ilike.*${q}*,sku.ilike.*${q}*)`,
            limit: 50
          }, { useAnonKey: false, silentError: true });
          if (productHits.rows?.length) {
            matchedTargetIds = productHits.rows.map((p) => asString(p.product_id)).filter(Boolean);
          }
        } catch {
          // ignore search error
        }
      }

      const payload = await repository.listAuditLogs({
        targetId: targetId || undefined,
        targetIds: matchedTargetIds,
        fromDate,
        toDate,
        action: action || undefined,
        limit: clampInteger(searchParams.get("limit"), 50, 1, 100),
        offset: clampInteger(searchParams.get("offset"), 0, 0, 1000000)
      }, context.accessToken);
      const enriched = await enrichProductAuditLogs(payload);

      if (q || date || action) {
        const lowerQ = q.toLowerCase();
        const filtered = enriched.rows.filter((row) => {
          if (date && typeof row.timestamp === "string") {
            if (row.timestamp.slice(0, 10) !== date) return false;
          }
          if (action) {
            const rowAction = asString(row.action).toLowerCase();
            const rowActionLabel = asString(row.action_label).toLowerCase();
            const filterAction = action.toLowerCase();
            if (
              rowAction !== filterAction &&
              !rowAction.includes(filterAction) &&
              !rowActionLabel.includes(filterAction)
            ) {
              return false;
            }
          }
          if (q) {
            const targetLabel = asString(row.target_label).toLowerCase();
            const actorLabel = asString(row.actor_label).toLowerCase();
            const actorEmail = asString(row.actor_email).toLowerCase();
            const actionLabel = asString(row.action_label).toLowerCase();
            const changeSummary = asString(row.change_summary).toLowerCase();
            const rawData = (JSON.stringify(row.old_value) + JSON.stringify(row.new_value)).toLowerCase();
            const matches =
              targetLabel.includes(lowerQ) ||
              actorLabel.includes(lowerQ) ||
              actorEmail.includes(lowerQ) ||
              actionLabel.includes(lowerQ) ||
              changeSummary.includes(lowerQ) ||
              rawData.includes(lowerQ);
            if (!matches) return false;
          }
          return true;
        });
        return { rows: filtered, count: filtered.length };
      }

      return enriched;
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
  if (color.length < 1 || color.length > 80) throw validationError("color", "color is required");
  if (size.length < 1 || size.length > 30) throw validationError("size", "size is required");
  if (!Number.isInteger(stockQuantity) || stockQuantity < 0) throw validationError("stockQuantity", "stockQuantity must be a non-negative integer");
  if (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0) throw validationError("lowStockThreshold", "lowStockThreshold must be a non-negative integer");
  if (body.colorHex && !/^#[0-9a-f]{6}$/i.test(String(body.colorHex))) throw validationError("colorHex", "colorHex must be #RRGGBB");
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
    throw validationError("name", "Name must contain 2 to 255 characters");
  }
  if (body.categoryId !== undefined) requireUuid(body.categoryId, "categoryId");
  if (body.status !== undefined) throw validationError("status", "Use the change-status endpoint");
  if (body.basePrice !== undefined || body.salePrice !== undefined) {
    throw validationError("price", "Use the pricing endpoint to change product prices");
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
  if (!changedFields.length) throw validationError("body", "At least one product field must be provided");
  return input;
}

/**
 * Validate a product status-change request body.
 */
export function validateStatusChange(body: JsonObject = {}) {
  if (!PRODUCT_STATUSES.includes(body.status as string)) {
    throw validationError("status", `Invalid status. Must be one of: ${PRODUCT_STATUSES.join(", ")}`);
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
    throw validationError("delta", "delta must be a non-zero integer");
  }
  return {
    delta,
    reason: requireReason(body.reason, "reason"),
    expectedVersion: requireVersion(body.expectedVersion),
    ipAddress: "0.0.0.0"
  };
}

function requireProductViewer(context: AuthContext | undefined): asserts context is AuthContext {
  if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
  if (!context.isAdmin || !context.profile?.is_active) {
    throw new HttpError(403, "ADMIN_REQUIRED", "Admin access is required");
  }
  if (!PRODUCT_VIEWER_ROLES.includes(context.roleCode)) {
    throw new HttpError(403, "RBAC_DENIED", "This admin role cannot access products");
  }
}

function requireProductAdmin(context: AuthContext | undefined, isComboOperation = false): asserts context is AuthContext {
  requireProductViewer(context);
  const allowedRoles = isComboOperation ? [...PRODUCT_ADMIN_ROLES, "admin_operator_gia_km"] : PRODUCT_ADMIN_ROLES;
  if (!allowedRoles.includes(context.roleCode)) {
    throw new HttpError(403, "RBAC_DENIED", "This admin role cannot modify products");
  }
}

function parseListFilters(searchParams: URLSearchParams): JsonObject {
  const status = searchParams.get("status") || "";
  if (status && !PRODUCT_STATUSES.includes(status)) {
    throw validationError("status", "Invalid status filter");
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
    throw validationError("price", "minPrice cannot exceed maxPrice");
  }
  return {
    q: String(searchParams.get("q") || "").trim().slice(0, 100),
    status: status || undefined,
    categoryId: categoryId || undefined,
    isCombo: searchParams.get("isCombo") === "true" ? true : searchParams.get("isCombo") === "false" ? false : undefined,
    isFeatured: searchParams.get("isFeatured") === "true" ? true : searchParams.get("isFeatured") === "false" ? false : undefined,
    minPrice,
    maxPrice,
    limit: clampInteger(searchParams.get("limit"), 20, 1, 1000),
    offset: clampInteger(searchParams.get("offset"), 0, 0, 1000000),
    order: allowedOrders.includes(orderInput) ? orderInput : "updated_at.desc"
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
    throw validationError(field, field === "categoryId" ? "Chọn danh mục hợp lệ" : `${field} phải là UUID`);
  }
}

function requireVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw validationError("expectedVersion", "expectedVersion must be a non-negative integer");
  }
  return version;
}

function optionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (text.length > maxLength) throw validationError("field", `Text must be at most ${maxLength} characters`);
  return text || null;
}

function requireReason(value: unknown, field: string): string {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (text.length < 10 || text.length > 500) {
    throw validationError(field, `${field} must contain 10 to 500 characters`);
  }
  return text;
}

function validateStringArray(value: unknown, field: string, maxItems: number, maxItemLength: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw validationError(field, `${field} must be an array with at most ${maxItems} items`);
  }
  return value.map((item) => {
    const text = String(item || "").trim();
    if (!text || text.length > maxItemLength) {
      throw validationError(field, `${field} contains an invalid item`);
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
    throw validationError("images", "Each image URL must be unique; the first image is primary");
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
    throw validationError("images", "An on-sale product requires a primary image at index 0");
  }
}

function validateImageColorMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("imageColors", "imageColors must map image URLs to variant colors");
  }
  const entries = Object.entries(value);
  if (entries.some(([, color]) => typeof color !== "string" || !color.trim())) {
    throw validationError("imageColors", "Every image color must be a nonempty variant color");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function validateImageColorLinks(value: unknown, images: string[], colors: string[]): Record<string, string> {
  const mapping = validateImageColorMap(value);
  for (const [url, color] of Object.entries(mapping)) {
    if (!images.includes(url) || !colors.includes(color)) {
      throw validationError("imageColors", "Each association must reference a product image and an exact variant color");
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

async function checkAndAlertLowStock(
  repository: ProductRepository,
  context: AuthContext,
  productId: string,
  variantId: string
): Promise<void> {
  try {
    const [product, variants] = await Promise.all([
      repository.findById(productId, context.accessToken),
      repository.listVariants(productId, context.accessToken)
    ]);
    if (!product) return;
    const targetVariant = (variants.rows || variants || []).find((v: JsonObject) => v.variant_id === variantId);
    if (!targetVariant) return;

    const stock = Number(targetVariant.stock_quantity || 0);
    const threshold = Number(targetVariant.low_stock_threshold ?? 5);

    if (stock <= threshold) {
      console.log(`[Low Stock Alert] Product "${product.name}" (${product.sku}), variant "${targetVariant.color}/${targetVariant.size}" is below threshold. Stock: ${stock}, Threshold: ${threshold}`);

      const adminUsers = await selectRows("users", {
        role: "eq.admin",
        is_active: "eq.true"
      }, { accessToken: context.accessToken });

      for (const admin of adminUsers.rows || []) {
        if (admin.email) {
          await insertRow("email_outbox", {
            recipient: admin.email,
            template_code: "low_stock_alert",
            subject: `[Velura Alert] Sản phẩm ${product.name} sắp hết hàng!`,
            body: `Cảnh báo: Sản phẩm "${product.name}" (SKU: ${product.sku}), biến thể "${targetVariant.color} / ${targetVariant.size}" hiện chỉ còn ${stock} sản phẩm trong kho (dưới ngưỡng tối thiểu là ${threshold}).\nVui lòng bổ sung tồn kho kịp thời.`,
            related_user_id: admin.user_id,
            metadata: {
              productId,
              variantId,
              stock,
              threshold
            }
          });
        }
      }
    }
  } catch (err: unknown) {
    console.error("[Low Stock Alert] Failed to queue warning emails:", errorMessage(err) || err);
  }
}

function parseOptionalPrice(value: string | null, field: string): number | undefined {
  if (value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw validationError(field, `${field} must be a non-negative number`);
  }
  return number;
}

/**
 * Resolves actor/product UUIDs into readable labels for the catalog audit table.
 */
async function enrichProductAuditLogs(
  payload: { rows: JsonObject[]; count: number | undefined } | JsonObject[] | unknown
): Promise<{ rows: JsonObject[]; count: number | undefined }> {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { rows?: JsonObject[] })?.rows)
      ? (payload as { rows: JsonObject[] }).rows
      : [];
  const count = Array.isArray(payload)
    ? payload.length
    : (payload as { count?: number | undefined })?.count;

  if (!rows.length) {
    return { rows: [], count: count ?? 0 };
  }

  const actorIds = uniqueIds(rows.map((row) => asString(row.actor_id)));
  const targetIds = uniqueIds(rows.map((row) => asString(row.target_id)));
  const productIdsFromPayload = uniqueIds(
    rows.flatMap((row) => [
      asString(asJsonObject(row.new_value)?.product_id),
      asString(asJsonObject(row.old_value)?.product_id)
    ])
  );

  const [actors, products] = await Promise.all([
    actorIds.length
      ? selectRows(
          "users",
          {
            select: "user_id,full_name,email,admin_role",
            user_id: `in.(${actorIds.join(",")})`
          },
          { useAnonKey: false, silentError: true }
        ).catch(() => ({ rows: [] as JsonObject[], count: 0 }))
      : Promise.resolve({ rows: [] as JsonObject[], count: 0 }),
    uniqueIds([...targetIds, ...productIdsFromPayload]).length
      ? selectRows(
          "product",
          {
            select: "product_id,sku,name",
            product_id: `in.(${uniqueIds([...targetIds, ...productIdsFromPayload]).join(",")})`
          },
          { useAnonKey: false, silentError: true }
        ).catch(() => ({ rows: [] as JsonObject[], count: 0 }))
      : Promise.resolve({ rows: [] as JsonObject[], count: 0 })
  ]);

  const actorMap = new Map(
    (actors.rows || []).map((row) => [asString(row.user_id), row] as const)
  );
  const productMap = new Map(
    (products.rows || []).map((row) => [asString(row.product_id), row] as const)
  );

  const enriched = rows.map((row) => {
    const actor = actorMap.get(asString(row.actor_id) || "");
    const oldValue = asJsonObject(row.old_value) || {};
    const newValue = asJsonObject(row.new_value) || {};
    const productId =
      asString(row.target_id) ||
      asString(newValue.product_id) ||
      asString(oldValue.product_id) ||
      "";
    const product = productMap.get(productId) || productMap.get(asString(newValue.product_id) || "");
    const actionLabel = productAuditActionLabel(asString(row.action), oldValue, newValue);
    const targetLabel = productAuditTargetLabel(product, oldValue, newValue, asString(row.target_id));
    const changeSummary = productAuditChangeSummary(oldValue, newValue, asString(row.action));
    const actorName = asString(actor?.full_name) || asString(row.actor_name) || "";
    const actorEmail = asString(actor?.email) || "";
    const actorRole = asString(row.actor_role) || asString(actor?.admin_role) || "";

    return {
      ...row,
      actor_name: actorName || actorEmail || asString(row.actor_id) || "Hệ thống",
      actor_email: actorEmail || null,
      actor_label: actorName && actorEmail
        ? `${actorName} (${actorEmail})`
        : actorName || actorEmail || asString(row.actor_id) || "Hệ thống",
      actor_role_label: productAuditRoleLabel(actorRole),
      target_label: targetLabel,
      action_label: actionLabel,
      change_summary: changeSummary,
      result: asString(row.result) || "Thành công"
    };
  });

  return { rows: enriched, count };
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

function productAuditActionLabel(
  action: string | null,
  oldValue: JsonObject,
  newValue: JsonObject
): string {
  const raw = String(action || "").toLowerCase();
  if (raw === "create") {
    if (newValue.color || newValue.size) return "Thêm biến thể";
    return "Thêm sản phẩm";
  }
  if (oldValue.status !== undefined && newValue.status !== undefined && oldValue.status !== newValue.status) {
    return "Đổi trạng thái";
  }
  if (
    oldValue.stock_quantity !== undefined &&
    newValue.stock_quantity !== undefined &&
    oldValue.stock_quantity !== newValue.stock_quantity
  ) {
    return "Điều chỉnh tồn kho";
  }
  if (raw === "update") return "Cập nhật sản phẩm";
  if (raw === "import" || raw.includes("csv")) return "Nhập CSV";
  return action || "—";
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
