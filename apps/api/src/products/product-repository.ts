import { HttpError } from "../http.js";
import { randomUUID } from "node:crypto";
import { callRpc, insertRow, selectOne, selectRows, updateRows, deleteRows } from "../supabase.js";
import { asJsonObject, asString, type JsonObject } from "../types.js";
import { PRODUCT_SELECT } from "./product-constants.js";

/**
 * PostgREST product repository used by `createProductService`.
 */
export type ProductRepository = ReturnType<typeof createProductRepository>;

/**
 * Create the product PostgREST repository.
 */
export function createProductRepository() {
  return {
    async list(filters: JsonObject, accessToken: string | null) {
      const query: Record<string, unknown> = {
        select: PRODUCT_SELECT,
        order: filters.order,
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.q) {
        const value = sanitizeSearch(filters.q);
        if (value) query.or = `(name.ilike.*${value}*,sku.ilike.*${value}*)`;
      }
      if (filters.status) query.status = `eq.${filters.status}`;
      if (filters.categoryId) query.category_id = `eq.${filters.categoryId}`;
      if (filters.isCombo !== undefined) query.is_combo = `eq.${filters.isCombo}`;
      if (filters.isFeatured !== undefined) query.is_featured = `eq.${filters.isFeatured}`;
      if (filters.minPrice !== undefined) query.sale_price = `gte.${filters.minPrice}`;
      if (filters.maxPrice !== undefined) {
        if (filters.minPrice !== undefined) {
          delete query.sale_price;
          query.and = `(sale_price.gte.${filters.minPrice},sale_price.lte.${filters.maxPrice})`;
        } else {
          query.sale_price = `lte.${filters.maxPrice}`;
        }
      }
      return withProductError(() => selectRows("product", query, authOptions(accessToken)));
    },

    async findById(productId: string, accessToken: string | null) {
      return withProductError(() => selectOne("product", {
        select: PRODUCT_SELECT,
        product_id: `eq.${productId}`
      }, authOptions(accessToken)));
    },

    async findBySku(sku: string, accessToken: string | null) {
      return withProductError(() => selectOne("product", {
        select: PRODUCT_SELECT,
        sku: `ilike.${sku.trim().toUpperCase()}`
      }, authOptions(accessToken)));
    },

    /** Resolve the persisted variant identity; prices remain on its parent product. */
    async findVariantBySku(sku: string, accessToken: string | null) {
      return withProductError(() => selectOne("variant", {
        select: "variant_id,product_id,sku,color,color_hex,size,stock_quantity,reserved_quantity,low_stock_threshold,version",
        sku: `ilike.${sku.trim().toUpperCase()}`
      }, authOptions(accessToken)));
    },

    /** Commit the fully revalidated CSV in one transaction, without existing-price writes or deletion. */
    async importCsv(rows: JsonObject[], ipAddress: string, accessToken: string | null) {
      try {
        return await rpc("admin_import_product_csv", { p_rows: rows, p_ip_address: ipAddress }, accessToken);
      } catch (error: unknown) {
        if (error instanceof HttpError && error.code === "CSV_VALIDATION_FAILED") {
          const detail = asJsonObject(error.details).details;
          if (typeof detail === "string") {
            let parsed: JsonObject;
            try { parsed = asJsonObject(JSON.parse(detail)); } catch { throw error; }
            if (Array.isArray(parsed.errors)) throw new HttpError(422, error.code, error.message, { errors: parsed.errors });
          }
        }
        throw error;
      }
    },

    async listVariants(productId: string, accessToken: string | null) {
      return withProductError(() => selectRows("variant", {
        select: "variant_id,product_id,sku,color,color_hex,size,size_measurements,stock_quantity,reserved_quantity,low_stock_threshold,version,updated_at",
        product_id: `eq.${productId}`,
        order: "color.asc,size.asc"
      }, authOptions(accessToken)));
    },

    async listCategories(accessToken: string | null) {
      return withProductError(() => selectRows("category", {
        select: "category_id,name,parent_id,slug,display_order",
        order: "display_order.asc,name.asc"
      }, authOptions(accessToken)));
    },

    async createProduct(input: JsonObject, accessToken: string | null) {
      return rpc("admin_create_product", {
        p_sku: input.sku,
        p_name: input.name,
        p_slug: input.slug,
        p_description: input.description || null,
        p_category_id: input.categoryId,
        p_brand: input.brand || null,
        p_base_price: input.basePrice,
        p_sale_price: input.salePrice,
        p_images: input.images || [],
        p_image_colors: input.imageColors ?? {},
        p_variants: input.variants,
        p_style_tags: input.styleTags || [],
        p_color_tone: input.colorTone || null,
        p_occasions: input.occasions || [],
        p_suitable_body_shapes: input.suitableBodyShapes || [],
        p_status: input.status || "on_sale",
        p_is_featured: Boolean(input.isFeatured),
        p_is_combo: Boolean(input.isCombo),
        p_collection: input.collection || null,
        p_seo_title: input.seoTitle || null,
        p_seo_description: input.seoDescription || null,
        p_expected_version: input.expectedVersion ?? 0,
        p_ip_address: input.ipAddress || null
      }, accessToken);
    },

    updateProduct(productId: string, input: JsonObject, accessToken: string | null) {
      return rpc("admin_update_product", {
        p_product_id: productId,
        p_name: input.name ?? null,
        p_description: input.description ?? null,
        p_category_id: input.categoryId ?? null,
        p_brand: input.brand ?? null,
        p_base_price: input.basePrice ?? null,
        p_sale_price: input.salePrice ?? null,
        p_images: input.images ?? null,
        p_image_colors: input.imageColors ?? null,
        p_style_tags: input.styleTags ?? null,
        p_color_tone: input.colorTone ?? null,
        p_occasions: input.occasions ?? null,
        p_suitable_body_shapes: input.suitableBodyShapes ?? null,
        p_status: null,
        p_is_featured: input.isFeatured ?? null,
        p_is_combo: input.isCombo ?? null,
        p_collection: input.collection ?? null,
        p_seo_title: input.seoTitle ?? null,
        p_seo_description: input.seoDescription ?? null,
        p_expected_version: input.expectedVersion,
        p_ip_address: input.ipAddress
      }, accessToken);
    },

    /** Change visibility once, with optimistic locking; never rewrite variants or retry through another status. */
    changeStatus(productId: string, input: JsonObject, accessToken: string | null) {
      return rpc("admin_change_product_status", {
        p_product_id: productId,
        p_new_status: input.status,
        p_reason: input.reason,
        p_expected_version: input.expectedVersion,
        p_ip_address: input.ipAddress || null
      }, accessToken);
    },

    updateStock(productId: string, variantId: string, input: JsonObject, accessToken: string | null) {
      return rpc("admin_update_stock", {
        p_product_id: productId,
        p_variant_id: variantId,
        p_delta: input.delta,
        p_reason: input.reason || null,
        p_expected_version: input.expectedVersion,
        p_ip_address: input.ipAddress
      }, accessToken);
    },

    async createVariant(productId: string, input: JsonObject, accessToken?: string | null) {
      try {
        return await rpc("admin_create_variant", {
          p_product_id: productId,
          p_color: input.color,
          p_color_hex: input.colorHex || null,
          p_size: input.size,
          p_size_measurements: input.sizeMeasurements || null,
          p_stock_quantity: input.stockQuantity ?? 0,
          p_low_stock_threshold: input.lowStockThreshold ?? 5,
          p_sku: input.sku || null,
          p_ip_address: input.ipAddress || null
        }, accessToken ?? null);
      } catch (error: unknown) {
        // Migration 024 may not be on remote yet; API RBAC already passed in the service.
        const blob = error instanceof HttpError
          ? `${error.code} ${error.message} ${JSON.stringify(error.details || {})}`
          : String(error);
        if (!/admin_create_variant|PGRST202|Could not find the function|42883|404/i.test(blob)) {
          throw error;
        }
        return withProductError(() =>
          insertRow(
            "variant",
            {
              variant_id: randomUUID(),
              product_id: productId,
              ...(input.sku ? { sku: input.sku } : {}),
              color: input.color,
              color_hex: input.colorHex || null,
              size: input.size,
              size_measurements: input.sizeMeasurements || null,
              stock_quantity: input.stockQuantity ?? 0,
              reserved_quantity: 0,
              low_stock_threshold: input.lowStockThreshold ?? 5,
              version: 1,
              updated_at: new Date().toISOString()
            },
            { useAnonKey: false }
          )
        );
      }
    },

    async listAuditLogs(filters: JsonObject, accessToken: string | null) {
      const query: Record<string, unknown> = {
        select: "audit_id,actor_id,actor_role,action,module,target_id,old_value,new_value,ip_address,timestamp",
        module: "eq.products",
        order: "timestamp.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.targetId) {
        query.target_id = `eq.${filters.targetId}`;
      } else if (Array.isArray(filters.targetIds) && filters.targetIds.length > 0) {
        query.target_id = `in.(${filters.targetIds.join(",")})`;
      }
      if (filters.action) {
        query.action = `eq.${filters.action}`;
      }
      if (filters.fromDate && filters.toDate) {
        query.and = `(timestamp.gte.${filters.fromDate},timestamp.lte.${filters.toDate})`;
      } else if (filters.fromDate) {
        query.timestamp = `gte.${filters.fromDate}`;
      } else if (filters.toDate) {
        query.timestamp = `lte.${filters.toDate}`;
      }
      return withProductError(() => selectRows("audit_log", query, authOptions(accessToken)));
    },

    async lowStockCount(accessToken: string | null) {
      return withProductError(() => callRpc("admin_list_low_stock", { p_limit: 100 }, authOptions(accessToken)));
    },

    async getComboItems(productId: string, accessToken: string | null) {
      return withProductError(async () => {
        const result = await selectRows("combo_item", {
          select: "combo_item_id,combo_product_id,component_product_id,component_variant_id,quantity",
          combo_product_id: `eq.${productId}`
        }, authOptions(accessToken));
        const items = (result.rows || []) as Array<Record<string, unknown>>;
        if (!items.length) return items;
        const compIds = [...new Set(items.map((i) => String(i.component_product_id || "")).filter(Boolean))];
        if (compIds.length > 0) {
          const compProducts = await selectRows("product", {
            select: "product_id,name,sku,base_price,sale_price,images,image_colors",
            product_id: `in.(${compIds.join(",")})`
          }, authOptions(accessToken));
          const compMap = new Map(((compProducts.rows || []) as Array<Record<string, unknown>>).map((p) => [String(p.product_id), p]));
          return items.map((i) => ({
            ...i,
            product: compMap.get(String(i.component_product_id)) || null
          }));
        }
        return items;
      });
    },

    async addComboItem(
      productId: string,
      componentProductId: string,
      componentVariantId: string | null,
      quantity: number,
      accessToken: string | null
    ) {
      return withProductError(() => insertRow("combo_item", {
        combo_item_id: randomUUID(),
        combo_product_id: productId,
        component_product_id: componentProductId,
        component_variant_id: componentVariantId,
        quantity
      }, authOptions(accessToken)));
    },

    async updateComboItem(productId: string, itemId: string, quantity: number, accessToken: string | null) {
      return withProductError(() => updateRows("combo_item", {
        combo_item_id: `eq.${itemId}`,
        combo_product_id: `eq.${productId}`
      }, { quantity }, authOptions(accessToken)));
    },

    async removeComboItem(productId: string, itemId: string, accessToken: string | null) {
      return withProductError(() => deleteRows("combo_item", {
        combo_item_id: `eq.${itemId}`,
        combo_product_id: `eq.${productId}`
      }, authOptions(accessToken)));
    }
  };
}

async function rpc(name: string, payload: unknown, accessToken: string | null): Promise<unknown> {
  return withProductError(() => callRpc(name, payload, authOptions(accessToken)));
}

function authOptions(accessToken: string | null | undefined) {
  return { useAnonKey: true, accessToken };
}

function sanitizeSearch(value: unknown): string {
  return String(value || "").replace(/[,*()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

async function withProductError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof HttpError && error.code === "SUPABASE_ERROR") {
      const details = asJsonObject(error.details);
      const databaseCode = asString(details.message) || asString(details.code) || "PRODUCT_DATABASE_ERROR";
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      throw new HttpError(status, databaseCode, productErrorMessage(databaseCode), error.details);
    }
    throw error;
  }
}

function productErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    RBAC_DENIED: "Bạn không có quyền ghi catalog sản phẩm",
    PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm",
    VERSION_CONFLICT: "Dữ liệu đã đổi; tải lại rồi thử lại",
    SKU_DUPLICATE: "SKU đã tồn tại",
    CSV_PRICE_CHANGE_FORBIDDEN: "CSV không được đổi giá hiện có; sử dụng quy trình quản lý giá",
    CSV_VALIDATION_FAILED: "CSV không hợp lệ; chưa ghi dòng nào vào catalog",
    SLUG_DUPLICATE: "Slug đã tồn tại",
    INVALID_STATUS: "Trạng thái sản phẩm không hợp lệ",
    INVALID_STATUS_TRANSITION: "Không thể chuyển sang trạng thái này",
    INVALID_CATEGORY: "Danh mục không tồn tại",
    PRICE_BELOW_COST: "Giá bán không được thấp hơn giá gốc nếu chưa có KM",
    STOCK_UNDERFLOW: "Tồn kho không được âm",
    CANNOT_DELETE: "Không xóa vật lý sản phẩm; hãy Tạm ẩn hoặc Ngừng kinh doanh",
    STATUS_REASON_REQUIRED: "Lý do đổi trạng thái tối thiểu 10 ký tự",
    COLOR_REQUIRED: "Màu biến thể bắt buộc",
    SIZE_REQUIRED: "Size biến thể bắt buộc",
    IMAGE_LIMIT_EXCEEDED: "Sản phẩm chỉ được có tối đa 20 ảnh",
    PRIMARY_IMAGE_REQUIRED: "Sản phẩm đang bán phải có ảnh chính",
    INVALID_PRODUCT_IMAGES: "Danh sách ảnh phải chứa các URL duy nhất, không để trống",
    INVALID_IMAGE_COLORS: "Liên kết ảnh và màu không hợp lệ",
    INVALID_IMAGE_COLOR_ASSOCIATION: "Ảnh phải thuộc sản phẩm và màu phải khớp chính xác biến thể",
    IMAGE_COLOR_VARIANT_REQUIRED: "Hãy bỏ liên kết ảnh trước khi xóa màu biến thể cuối cùng",
    STOCK_INVALID: "Tồn kho phải là số không âm"
  };
  if (messages[code]) {
    return messages[code];
  }
  if (/permission denied for table product/i.test(code)) {
    return "Ghi sản phẩm phải qua RPC admin (RLS). Kiểm tra migration 024.";
  }
  if (/permission denied for table variant/i.test(code)) {
    return "Ghi biến thể phải qua RPC admin_create_variant (RLS).";
  }
  return "Thao tác catalog thất bại";
}
