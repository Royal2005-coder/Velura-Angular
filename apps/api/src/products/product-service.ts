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

/**
 * Admin product use-cases used by `handleProductRoute`.
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
  parseCsv(context: AuthContext | undefined, csvContent: unknown): Promise<unknown>;
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
      const product = asJsonObject(await repository.createProduct(input, context.accessToken));

      // Auto-create a default variant with the initial stock and threshold if repository method exists
      if (repository && typeof repository.createVariant === "function") {
        const initialStock = body.initialStock !== undefined ? Number(body.initialStock) : 0;
        const lowStockThreshold = body.lowStockThreshold !== undefined ? Number(body.lowStockThreshold) : 5;

        await repository.createVariant(product.product_id as string, {
          color: "Mặc định",
          colorHex: "#FFFFFF",
          size: "F",
          stockQuantity: Number.isInteger(initialStock) && initialStock >= 0 ? initialStock : 0,
          lowStockThreshold: Number.isInteger(lowStockThreshold) && lowStockThreshold >= 0 ? lowStockThreshold : 5
        }, context.accessToken);

        await syncProductStockStatus(repository, context, product.product_id as string, "Khởi tạo tồn kho sản phẩm mới", input.ipAddress);
      }

      return product;
    },

    async update(context, productId, body, requestMeta) {
      requireUuid(productId, "productId");
      const current = await repository.findById(productId, context?.accessToken ?? null);
      if (!current) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product was not found");
      requireProductAdmin(context, current.is_combo === true);
      const input = validateUpdateProduct(body);
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
      input.ipAddress = requestMeta.ipAddress || "0.0.0.0";
      return repository.changeStatus(productId, input, context.accessToken);
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
      if (lines.length > CSV_MAX_ROWS) {
        throw validationError("csv", `CSV cannot exceed ${CSV_MAX_ROWS} rows`);
      }

      const headers = lines[0].map((h) => h.trim().toLowerCase());
      const missing = CSV_REQUIRED_COLUMNS.filter((col) => !headers.includes(col));
      if (missing.length) {
        throw validationError("csv", `Missing required columns: ${missing.join(", ")}`);
      }

      const errors: JsonObject[] = [];
      const rows: JsonObject[] = [];
      for (let i = 1; i < lines.length; i++) {
        const row = parseCsvRow(headers, lines[i]);
        const rowNum = i + 1;

        if (!row.sku || !SKU_PATTERN.test(row.sku)) {
          errors.push({ row: rowNum, field: "sku", message: "SKU không đúng dạng VL-AO001" });
          continue;
        }
        if (!row.name || row.name.length < 2) {
          errors.push({ row: rowNum, field: "name", message: "Tên bắt buộc, tối thiểu 2 ký tự" });
          continue;
        }
        const basePrice = Number(row.base_price);
        if (!Number.isFinite(basePrice) || basePrice < 0) {
          errors.push({ row: rowNum, field: "base_price", message: "Giá gốc phải là số không âm" });
          continue;
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.category_id || "")) {
          errors.push({ row: rowNum, field: "category_id", message: "category_id phải là UUID danh mục" });
          continue;
        }
        const salePrice = row.sale_price === "" || row.sale_price === undefined ? basePrice : Number(row.sale_price);
        if (!Number.isFinite(salePrice) || salePrice < 0) {
          errors.push({ row: rowNum, field: "sale_price", message: "Giá bán phải là số không âm" });
          continue;
        }
        const status = row.status || "on_sale";
        if (!PRODUCT_STATUSES.includes(status)) {
          errors.push({ row: rowNum, field: "status", message: "Trạng thái phải là on_sale, hidden, out_of_stock hoặc discontinued" });
          continue;
        }
        rows.push({
          sku: row.sku,
          name: row.name,
          base_price: basePrice,
          category_id: row.category_id || null,
          description: row.description || null,
          sale_price: salePrice,
          status,
          images: row.image_url ? validateImageUrls([row.image_url]) : [],
          is_featured: row.is_featured === "true"
        });
      }

      return { rows, errors, totalRows: lines.length - 1, validRows: rows.length };
    },

    async commitCsv(context, csvContent, requestMeta) {
      requireProductAdmin(context);
      const parsed = asJsonObject(await this.parseCsv(context, csvContent));
      const csvErrors = Array.isArray(parsed.errors) ? parsed.errors : [];
      if (csvErrors.length) {
        throw new HttpError(422, "CSV_VALIDATION_FAILED", "CSV còn dòng lỗi, chưa ghi vào catalog", { errors: csvErrors });
      }
      const parsedRows = Array.isArray(parsed.rows) ? parsed.rows as JsonObject[] : [];
      if (parsedRows.length === 0) throw validationError("csv", "Không có dòng hợp lệ để nhập");

      const results: JsonObject[] = [];
      for (const row of parsedRows) {
        try {
          const existing = repository.findBySku ? await repository.findBySku(row.sku as string, context.accessToken) : null;
          if (existing) {
            // Update existing product
            const updateInput = {
              name: row.name,
              description: row.description,
              categoryId: row.category_id,
              images: row.images,
              isFeatured: row.is_featured,
              expectedVersion: existing.version,
              ipAddress: requestMeta.ipAddress || "0.0.0.0"
            };
            await repository.updateProduct(existing.product_id as string, updateInput, context.accessToken);

            if (existing.status !== row.status) {
              const fresh = await repository.findById(existing.product_id as string, context.accessToken);
              await repository.changeStatus(existing.product_id as string, {
                status: row.status,
                reason: "Cập nhật trạng thái tự động qua import CSV",
                expectedVersion: (fresh as JsonObject).version,
                ipAddress: requestMeta.ipAddress || "0.0.0.0"
              }, context.accessToken);
            }

            results.push({ sku: row.sku, status: "updated", product_id: existing.product_id });
          } else {
            // Create new product
            const slug = String(row.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + String(row.sku).toLowerCase();
            const product = asJsonObject(await this.create(context, {
              sku: row.sku,
              name: row.name,
              slug: slug,
              basePrice: row.base_price,
              salePrice: row.sale_price,
              categoryId: row.category_id,
              status: row.status,
              description: row.description,
              images: row.images || [],
              isFeatured: row.is_featured,
              expectedVersion: 0
            }, requestMeta));
            results.push({ sku: row.sku, status: "created", product_id: product.product_id });
          }
        } catch (error: unknown) {
          results.push({ sku: row.sku, status: "error", message: errorMessage(error) || "Unknown error" });
        }
      }

      const created = results.filter((r) => r.status === "created").length;
      const updated = results.filter((r) => r.status === "updated").length;
      const failed = results.filter((r) => r.status === "error").length;
      return { created, updated, failed, total: parsedRows.length, results };
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
      const payload = await repository.listAuditLogs({
        targetId: targetId || undefined,
        limit: clampInteger(searchParams.get("limit"), 50, 1, 100),
        offset: clampInteger(searchParams.get("offset"), 0, 0, 1000000)
      }, context.accessToken);
      return enrichProductAuditLogs(payload);
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
    }
  };
}

/**
 * Validate a create-variant request body.
 */
export function validateCreateVariant(body: JsonObject = {}) {
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
  return {
    sku,
    name,
    slug,
    description: optionalText(body.description, 5000),
    categoryId: body.categoryId,
    brand: optionalText(body.brand, 100),
    basePrice,
    salePrice,
    images: validateImageUrls(body.images),
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
