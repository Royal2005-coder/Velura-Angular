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
        sku: `eq.${sku}`
      }, authOptions(accessToken)));
    },

    async listVariants(productId: string, accessToken: string | null) {
      return withProductError(() => selectRows("variant", {
        select: "variant_id,product_id,color,color_hex,size,size_measurements,stock_quantity,reserved_quantity,low_stock_threshold,version,updated_at",
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
      return withProductError(async () => {
        const productId = randomUUID();
        const result = await insertRow("product", {
          product_id: productId,
          sku: input.sku,
          name: input.name,
          slug: input.slug,
          description: input.description || null,
          category_id: input.categoryId,
          brand: input.brand || null,
          base_price: input.basePrice,
          sale_price: input.salePrice,
          images: input.images || [],
          style_tags: input.styleTags || [],
          color_tone: input.colorTone || null,
          occasions: input.occasions || [],
          suitable_body_shapes: input.suitableBodyShapes || [],
          status: input.status || "on_sale",
          is_featured: input.isFeatured || false,
          is_combo: input.isCombo || false,
          collection: input.collection || null,
          seo_title: input.seoTitle || null,
          seo_description: input.seoDescription || null,
          version: 1
        }, accessToken as never);
        return result;
      });
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

    async changeStatus(productId: string, input: JsonObject, accessToken: string | null) {
      return withProductError(async () => {
        const product = await selectOne("product", {
          select: "product_id,status,version",
          product_id: `eq.${productId}`
        }, authOptions(accessToken));
        if (!product) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product not found");
        if (product.status === input.status) throw new HttpError(422, "STATUS_UNCHANGED", "Status unchanged");
        if (product.version !== input.expectedVersion) throw new HttpError(409, "VERSION_CONFLICT", "Version conflict");
        const results = await updateRows("product", {
          product_id: `eq.${productId}`,
          version: `eq.${product.version}`
        }, {
          status: input.status,
          version: (product.version as number) + 1,
          updated_at: new Date().toISOString()
        }, authOptions(accessToken));
        if (!results || !results.length) throw new HttpError(409, "VERSION_CONFLICT", "Version conflict");
        return results[0];
      });
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
      return withProductError(() => insertRow("variant", {
        variant_id: randomUUID(),
        product_id: productId,
        color: input.color,
        color_hex: input.colorHex || null,
        size: input.size,
        size_measurements: input.sizeMeasurements || null,
        stock_quantity: input.stockQuantity,
        reserved_quantity: 0,
        low_stock_threshold: input.lowStockThreshold,
        version: 1,
        updated_at: new Date().toISOString()
      }, authOptions(accessToken)));
    },

    async listAuditLogs(filters: JsonObject, accessToken: string | null) {
      const query: Record<string, unknown> = {
        select: "audit_id,actor_id,actor_role,action,module,target_id,old_value,new_value,ip_address,timestamp",
        module: "eq.products",
        order: "timestamp.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.targetId) query.target_id = `eq.${filters.targetId}`;
      return withProductError(() => selectRows("audit_log", query, authOptions(accessToken)));
    },

    async lowStockCount(accessToken: string | null) {
      return withProductError(() => callRpc("admin_list_low_stock", { p_limit: 100 }, authOptions(accessToken)));
    },

    async getComboItems(productId: string, accessToken: string | null) {
      return withProductError(() => selectRows("combo_item", {
        select: "combo_item_id,combo_product_id,component_product_id,component_variant_id,quantity",
        combo_product_id: `eq.${productId}`
      }, authOptions(accessToken)));
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
    RBAC_DENIED: "You do not have permission to manage products",
    PRODUCT_NOT_FOUND: "Product was not found",
    VERSION_CONFLICT: "Product data changed; reload before trying again",
    SKU_DUPLICATE: "A product with this SKU already exists",
    SLUG_DUPLICATE: "A product with this slug already exists",
    INVALID_STATUS: "Invalid product status",
    INVALID_CATEGORY: "Category not found",
    PRICE_BELOW_COST: "Sale price cannot be lower than base price without approved promotion",
    STOCK_UNDERFLOW: "Stock cannot go below zero",
    CANNOT_DELETE: "Products cannot be physically deleted from the database"
  };
  return messages[code] || "Product database operation failed";
}
