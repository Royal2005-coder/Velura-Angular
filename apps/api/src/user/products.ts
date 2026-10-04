import { HttpError, sendJson } from "../http.js";
import { selectOne, selectRows } from "../supabase.js";
import {
  type HeaderMap,
  type HttpRequest,
  type HttpResponse,
  type JsonObject
} from "../types.js";

/** In-memory cache wrapper with timestamp and TTL. */
interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  ttlMs: number;
}

let categoriesCache: CacheEntry<JsonObject[]> | null = null;
let productsCache: CacheEntry<JsonObject[]> | null = null;
let liteProductsCache: CacheEntry<JsonObject[]> | null = null;

const CATEGORIES_CACHE_TTL_MS = 60 * 1000; // 60s
const PRODUCTS_CACHE_TTL_MS = 30 * 1000;   // 30s

/**
 * Invalidate product catalog in-memory cache when changes occur.
 */
export function invalidateCatalogCache(): void {
  categoriesCache = null;
  productsCache = null;
  liteProductsCache = null;
}

/**
 * Public catalog: product list/detail and category list with counts.
 */
export async function handleProductsRoute(
  req: HttpRequest,
  res: HttpResponse,
  subRoute: string | undefined,
  action: string | undefined,
  corsHeaders: HeaderMap
): Promise<void> {
  if (subRoute === "products") {
    if (req.method === "GET") {
      if (action) {
        const product = await selectOne("product", {
          select: "*,category:category_id(*)",
          product_id: `eq.${action}`
        }, { count: "none", useAnonKey: true });
        if (!product) {
          throw new HttpError(404, "NOT_FOUND", "Không tìm thấy sản phẩm");
        }
        const { rows: dbVariants } = await selectRows("variant", {
          product_id: `eq.${action}`
        }, { count: "none", useAnonKey: true });
        let variants: JsonObject[] = dbVariants;

        if (product.is_combo) {
          const { rows: comboItems } = await selectRows("combo_item", {
            combo_product_id: `eq.${product.product_id}`
          }, { count: "none", useAnonKey: true });

          if (variants.length === 0) {
            const variantIds = comboItems.map((ci) => ci.component_variant_id).filter(Boolean);
            if (variantIds.length > 0) {
              const { rows: compVariants } = await selectRows("variant", {
                variant_id: `in.(${variantIds.join(",")})`
              }, { count: "none", useAnonKey: true });
              variants = compVariants.map((v) => ({ ...v, product_id: product.product_id }));
            }
          }

          // Fetch full component product details for combo display
          const componentProductIds = [...new Set(comboItems.map((ci) => ci.component_product_id).filter(Boolean))];
          let comboComponents: JsonObject[] = [];
          if (componentProductIds.length > 0) {
            const [prodResult, catResult, varResult] = await Promise.all([
              selectRows("product", {
                product_id: `in.(${componentProductIds.join(",")})`
              }, { count: "none", useAnonKey: true }),
              selectRows("category", {}, { count: "none", useAnonKey: true }),
              selectRows("variant", {
                product_id: `in.(${componentProductIds.join(",")})`
              }, { count: "none", useAnonKey: true })
            ]);

            const compProducts = prodResult.rows;
            const compCategories = catResult.rows;
            const allCompVariants = varResult.rows;
            const compCatMap = new Map(compCategories.map((c) => [c.category_id, c.name]));

            const compVariantsMap = new Map<unknown, JsonObject[]>();
            allCompVariants.forEach((v) => {
              const existing = compVariantsMap.get(v.product_id);
              if (existing) {
                existing.push(v);
              } else {
                compVariantsMap.set(v.product_id, [v]);
              }
            });

            const seenProducts = new Set<unknown>();
            comboComponents = compProducts
              .filter((cp) => {
                if (seenProducts.has(cp.product_id)) return false;
                seenProducts.add(cp.product_id);
                return true;
              })
              .map((cp) => {
                const item = comboItems.find((ci) => ci.component_product_id === cp.product_id);
                const rawQty = item ? Number(item.quantity) : 1;
                const qty = Number.isFinite(rawQty) && rawQty > 0 && rawQty < 10 ? rawQty : 1;
                const compVariants = compVariantsMap.get(cp.product_id) || [];
                return {
                  product_id: cp.product_id,
                  name: cp.name,
                  slug: cp.slug,
                  images: cp.images || [],
                  base_price: cp.base_price,
                  sale_price: cp.sale_price,
                  category_name: compCatMap.get(cp.category_id) || "",
                  quantity: qty,
                  variants: compVariants.map((v) => ({
                    variant_id: v.variant_id,
                    color: v.color,
                    color_hex: v.color_hex,
                    size: v.size,
                    stock_quantity: v.stock_quantity || 0,
                    reserved_quantity: v.reserved_quantity || 0,
                    sku: v.sku
                  }))
                };
              });
          }
          product.combo_components = comboComponents;
          product.total_original_price = comboComponents.reduce((sum, c) => sum + (Number(c.base_price) * Number(c.quantity)), 0);
          product.combo_savings = Number(product.total_original_price) - Number(product.sale_price || product.base_price);
        }

        const category = product.category || (product.category_id ? await selectOne("category", { category_id: `eq.${product.category_id}` }, { count: "none", useAnonKey: true }) : null);

        // Fetch approved reviews for this product
        const { rows: dbReviews } = await selectRows("review", {
          product_id: `eq.${action}`,
          status: "eq.approved"
        }, { count: "none", useAnonKey: true });

        let reviews: JsonObject[] = [];
        if (dbReviews && dbReviews.length > 0) {
          const userIds = [...new Set(dbReviews.map((r) => r.user_id).filter(Boolean))];
          if (userIds.length > 0) {
            const { rows: reviewUsers } = await selectRows("users", {
              user_id: `in.(${userIds.join(",")})`
            }, { count: "none", useAnonKey: true });
            const userMap = new Map(reviewUsers.map((u) => [u.user_id, u.full_name]));
            reviews = dbReviews.map((r) => ({
              ...r,
              user_full_name: userMap.get(r.user_id) || "Khách hàng ẩn danh"
            }));
          } else {
            reviews = dbReviews.map((r) => ({ ...r, user_full_name: "Khách hàng ẩn danh" }));
          }
        }

        // Calculate sold_count dynamically for this single product without scanning all orders
        let sold_count = 0;
        try {
          const variantIds = variants.map((v) => v.variant_id).filter(Boolean);
          if (variantIds.length > 0) {
            const { rows: orderItems } = await selectRows("order_item", {
              select: "quantity,variant_id",
              variant_id: `in.(${variantIds.join(",")})`
            }, { count: "none", useAnonKey: true });
            sold_count = orderItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
          }
        } catch (err: unknown) {
          console.error("Error calculating sold_count for single product:", err);
        }

        return sendJson(res, 200, { ...product, variants, category, reviews, sold_count }, {
          ...corsHeaders,
          "cache-control": "public, max-age=30, s-maxage=60, stale-while-revalidate=180"
        });
      }

      const requestUrl = new URL(req.url || "/api/user/products", "http://localhost");
      const lite = requestUrl.searchParams.get("lite") === "1";
      const now = Date.now();

      if (lite) {
        if (liteProductsCache && (now - liteProductsCache.cachedAt < liteProductsCache.ttlMs)) {
          return sendJson(res, 200, liteProductsCache.data, {
            ...corsHeaders,
            "cache-control": "public, max-age=15, s-maxage=30, stale-while-revalidate=120"
          });
        }
      } else {
        if (productsCache && (now - productsCache.cachedAt < productsCache.ttlMs)) {
          return sendJson(res, 200, productsCache.data, {
            ...corsHeaders,
            "cache-control": "public, max-age=15, s-maxage=30, stale-while-revalidate=120"
          });
        }
      }

      // Parallel batch fetch using PostgREST foreign key embedding:
      // Product + Category + Variants in 1 single join query, plus combo items and review ratings in parallel
      const [productResult, comboResult, reviewResult] = await Promise.all([
        selectRows("product", {
          select: "product_id,sku,is_combo,name,slug,description,brand,base_price,sale_price,images,style_tags,color_tone,occasions,suitable_body_shapes,status,is_featured,collection,seo_title,seo_description,created_at,updated_at,version,category:category_id(category_id,name,slug),variants:variant(variant_id,color,color_hex,size,stock_quantity,reserved_quantity)",
          status: "in.(on_sale,out_of_stock)"
        }, { count: "none", useAnonKey: true }),
        selectRows("combo_item", {}, { count: "none", useAnonKey: true }).catch(() => ({ rows: [] as JsonObject[] })),
        selectRows("review", { select: "product_id,rating", status: "eq.approved" }, { count: "none", useAnonKey: true }).catch(() => ({ rows: [] as JsonObject[] }))
      ]);

      const products = productResult.rows;
      const comboItems = comboResult.rows || [];
      const allReviews = reviewResult.rows || [];

      // Calculate bulk reviews rating map
      const ratingMap = new Map<unknown, { sum: number; count: number }>();
      allReviews.forEach((r) => {
        if (!ratingMap.has(r.product_id)) {
          ratingMap.set(r.product_id, { sum: 0, count: 0 });
        }
        const data = ratingMap.get(r.product_id);
        if (data) {
          data.sum += Number(r.rating || 0);
          data.count += 1;
        }
      });

      if (lite) {
        const liteRows = products.map((p) => {
          const cat = p.category as JsonObject | null | undefined;
          return {
            product_id: p.product_id,
            sku: p.sku,
            name: p.name,
            slug: p.slug,
            base_price: p.base_price,
            sale_price: p.sale_price,
            images: p.images,
            is_featured: p.is_featured,
            is_combo: p.is_combo,
            status: p.status,
            sold_count: p.sold_count || 0,
            collection: p.collection || null,
            updated_at: p.updated_at || null,
            category_slug: cat ? cat.slug : null,
            category_name: cat ? cat.name : null
          };
        });
        liteProductsCache = { data: liteRows, cachedAt: now, ttlMs: PRODUCTS_CACHE_TTL_MS };
        return sendJson(res, 200, liteRows, {
          ...corsHeaders,
          "cache-control": "public, max-age=15, s-maxage=30, stale-while-revalidate=120"
        });
      }

      const productsWithVariants = products.map((p) => {
        let variants = Array.isArray(p.variants) ? (p.variants as JsonObject[]) : [];
        if (p.is_combo && comboItems.length > 0 && variants.length === 0) {
          const itemVariantIds = comboItems
            .filter((ci) => ci.combo_product_id === p.product_id)
            .map((ci) => ci.component_variant_id);
          if (itemVariantIds.length > 0) {
            variants = itemVariantIds.map((vid) => ({ variant_id: vid, product_id: p.product_id }));
          }
        }

        const reviewData = ratingMap.get(p.product_id);
        let rating_value = 0;
        let rating_count = 0;
        if (reviewData && reviewData.count > 0) {
          rating_value = Number((reviewData.sum / reviewData.count).toFixed(1));
          rating_count = reviewData.count;
        }

        const cat = p.category as JsonObject | null | undefined;
        return {
          ...p,
          variants,
          category_slug: cat ? cat.slug : null,
          category_name: cat ? cat.name : null,
          sold_count: Number(p.sold_count || 0),
          rating_value,
          rating_count
        };
      });

      productsCache = { data: productsWithVariants, cachedAt: now, ttlMs: PRODUCTS_CACHE_TTL_MS };
      return sendJson(res, 200, productsWithVariants, {
        ...corsHeaders,
        "cache-control": "public, max-age=15, s-maxage=30, stale-while-revalidate=120"
      });
    }
  }

  if (subRoute === "categories") {
    if (req.method === "GET") {
      const now = Date.now();
      if (categoriesCache && (now - categoriesCache.cachedAt < categoriesCache.ttlMs)) {
        return sendJson(res, 200, categoriesCache.data, {
          ...corsHeaders,
          "cache-control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300"
        });
      }

      const [catResult, prodResult] = await Promise.all([
        selectRows("category", {
          select: "category_id,name,slug,display_order,parent_id",
          order: "display_order.asc,name.asc"
        }, { count: "none", useAnonKey: true }),
        selectRows("product", {
          select: "category_id",
          status: "eq.on_sale"
        }, { count: "none", useAnonKey: true })
      ]);

      const counts = new Map<string, number>();
      for (const p of prodResult.rows) {
        if (p.category_id) {
          const cid = String(p.category_id);
          counts.set(cid, (counts.get(cid) || 0) + 1);
        }
      }

      const categoriesWithCount = catResult.rows.map((c) => ({
        ...c,
        product_count: counts.get(String(c.category_id)) || 0
      }));

      categoriesCache = {
        data: categoriesWithCount,
        cachedAt: now,
        ttlMs: CATEGORIES_CACHE_TTL_MS
      };

      return sendJson(res, 200, categoriesWithCount, {
        ...corsHeaders,
        "cache-control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300"
      });
    }
  }

  throw new HttpError(404, "NOT_FOUND", "Route products or categories not found");
}
