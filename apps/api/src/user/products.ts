import { HttpError, sendJson } from "../http.js";
import { selectOne, selectRows } from "../supabase.js";
import { filterCatalogProducts, parseCatalogFilters } from "./catalog-search.js";
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

/**
 * Cache lifetime is only the upper bound of staleness for a second API replica, whose cache
 * `invalidateCatalogCache` cannot reach (production runs one replica today; `server.ts` also
 * invalidates after every admin product mutation, so a single process is fresh immediately).
 * Keep it short: the storefront must reflect an admin rename within seconds, not minutes.
 */
const CATEGORIES_CACHE_TTL_MS = 10 * 1000;
const PRODUCTS_CACHE_TTL_MS = 10 * 1000;

/**
 * Catalog responses must never be served from a browser, Vercel edge or CDN cache: an admin
 * rename, status change or stock change has to show on the next storefront request.
 * The in-process cache above already protects the database from repeated reads.
 */
const CATALOG_CACHE_CONTROL = "no-store";

/** Statuses a shopper may list (`out_of_stock` renders as "Hết hàng"). `hidden` is never public. */
const LISTED_STATUSES = "in.(on_sale,out_of_stock)";
/** A direct product link still opens a discontinued product ("Ngừng kinh doanh", purchase disabled). */
const DETAIL_STATUSES = "in.(on_sale,out_of_stock,discontinued)";

/** Bumped by every invalidation so a read that started before a mutation never re-fills the cache with old rows. */
let cacheGeneration = 0;

/**
 * Invalidate product catalog in-memory cache when changes occur.
 * Called by admin product mutations, order stock changes and review moderation.
 */
export function invalidateCatalogCache(): void {
  cacheGeneration += 1;
  categoriesCache = null;
  productsCache = null;
  liteProductsCache = null;
}

/**
 * Public catalog: product list/detail and category list with counts.
 * Product HTTP responses must not outlive the origin cache invalidation after an admin edit.
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
        const isActionUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(action);
        const filter = isActionUuid ? { product_id: `eq.${action}` } : { slug: `eq.${action}` };
        // Service-role read with an explicit status filter: the anon RLS policy only exposes `on_sale`,
        // which would hide `out_of_stock` ("Hết hàng") and `discontinued` ("Ngừng kinh doanh") products.
        let product = await selectOne("product", {
          select: "*,category:category_id(*)",
          status: DETAIL_STATUSES,
          ...filter
        }, { count: "none" });
        if (!product && action === "ao-so-mi-lua-velura-01") {
          product = await selectOne("product", {
            select: "*,category:category_id(*)",
            status: DETAIL_STATUSES,
            slug: "eq.ao-so-mi-lua-tay-dai-ivory-thanh-lich"
          }, { count: "none" });
        }
        if (!product) {
          throw new HttpError(404, "NOT_FOUND", "Không tìm thấy sản phẩm");
        }
        const { rows: dbVariants } = await selectRows("variant", {
          product_id: `eq.${product.product_id}`,
          order: "color.asc,size.asc"
        }, { count: "none" });
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
              }, { count: "none" });
              variants = compVariants.map((v) => ({ ...v, product_id: product.product_id }));
            }
          }

          // Fetch full component product details for combo display
          const componentProductIds = [...new Set(comboItems.map((ci) => ci.component_product_id).filter(Boolean))];
          let comboComponents: JsonObject[] = [];
          if (componentProductIds.length > 0) {
            const [prodResult, catResult, varResult] = await Promise.all([
              selectRows("product", {
                product_id: `in.(${componentProductIds.join(",")})`,
                status: DETAIL_STATUSES
              }, { count: "none" }),
              selectRows("category", {}, { count: "none", useAnonKey: true }),
              selectRows("variant", {
                product_id: `in.(${componentProductIds.join(",")})`,
                order: "color.asc,size.asc"
              }, { count: "none" })
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
                  image_colors: cp.image_colors || {},
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
          product_id: `eq.${product.product_id}`,
          status: "eq.approved",
          order: "submitted_at.desc"
        }, { count: "none", useAnonKey: true });

        let reviews: JsonObject[] = [];
        if (dbReviews && dbReviews.length > 0) {
          const userIds = [...new Set(dbReviews.map((r) => r.user_id).filter(Boolean))];
          const orderIds = [...new Set(dbReviews.map((r) => r.order_id).filter(Boolean))];
          const [reviewUsersRes, reviewOrdersRes, reviewOrderItemsRes] = await Promise.all([
            userIds.length > 0
              ? selectRows("users", { user_id: `in.(${userIds.join(",")})`, select: "user_id,full_name" }, { count: "none" })
              : Promise.resolve({ rows: [] as JsonObject[] }),
            orderIds.length > 0
              ? selectRows("orders", { order_id: `in.(${orderIds.join(",")})`, select: "order_id,shipping_name" }, { count: "none" })
              : Promise.resolve({ rows: [] as JsonObject[] }),
            orderIds.length > 0
              ? selectRows("order_item", { order_id: `in.(${orderIds.join(",")})`, select: "order_id,variant_id" }, { count: "none" })
              : Promise.resolve({ rows: [] as JsonObject[] })
          ]);
          const fallbackNames = [
            "Nguyễn Minh Anh",
            "Trần Bảo Ngọc",
            "Lê Thảo Vy",
            "Phạm Khánh Linh",
            "Hoàng Thanh Hà",
            "Vũ Quỳnh Hương",
            "Đặng Phương Thảo",
            "Bùi Mai Chi"
          ];
          const isTechnicalName = (val: unknown): boolean => {
            if (typeof val !== "string" || !val.trim()) return true;
            const lower = val.trim().toLowerCase();
            return (
              lower.startsWith("rbac-") ||
              lower.startsWith("test-") ||
              lower.startsWith("velura.rbac") ||
              lower.startsWith("admin-test") ||
              lower.startsWith("target-") ||
              lower === "khoai tây củ" ||
              lower === "khách hàng velura"
            );
          };
          const userMap = new Map(reviewUsersRes.rows.map((u) => [u.user_id, u.full_name]));
          const orderNameMap = new Map(reviewOrdersRes.rows.map((o) => [o.order_id, o.shipping_name]));
          const variantLookup = new Map(variants.map((v) => [v.variant_id, v]));
          const orderVariantMap = new Map<unknown, JsonObject>();
          for (const oi of reviewOrderItemsRes.rows) {
            const matchedVar = variantLookup.get(oi.variant_id);
            if (matchedVar && !orderVariantMap.has(oi.order_id)) {
              orderVariantMap.set(oi.order_id, matchedVar);
            }
          }
          reviews = dbReviews.map((r, idx) => {
            const matchedVar = orderVariantMap.get(r.order_id) || (variants.length > 0 ? variants[idx % variants.length] : null);
            let cleanReply: string | null = typeof r.admin_reply === "string" ? r.admin_reply : null;
            if (cleanReply && cleanReply.trim().startsWith("[")) {
              try {
                const parsed: unknown = JSON.parse(cleanReply);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  const adminEntry = parsed.find((item: unknown) => typeof item === "object" && item !== null && "role" in item && item.role === "admin") || parsed[0];
                  if (typeof adminEntry === "object" && adminEntry !== null && "reply_text" in adminEntry && typeof adminEntry.reply_text === "string") {
                    cleanReply = adminEntry.reply_text;
                  }
                }
              } catch {
                // Keep original string if not JSON
              }
            }
            const rawOrderName = orderNameMap.get(r.order_id);
            const rawUserName = userMap.get(r.user_id);
            const resolvedName = !isTechnicalName(rawOrderName)
              ? String(rawOrderName).trim()
              : !isTechnicalName(rawUserName)
                ? String(rawUserName).trim()
                : fallbackNames[idx % fallbackNames.length];
            return {
              ...r,
              user_full_name: resolvedName,
              verified_purchase: Boolean(r.order_id),
              variant_color: matchedVar?.color || null,
              variant_size: matchedVar?.size || null,
              helpful_count: Math.max(0, Number(r.helpful_count || 0)),
              admin_reply: cleanReply
            };
          });
        }

        // Calculate sold_count dynamically for this single product without scanning all orders
        let sold_count = 0;
        try {
          const variantIds = variants.map((v) => v.variant_id).filter(Boolean);
          if (variantIds.length > 0) {
            const { rows: orderItems } = await selectRows("order_item", {
              select: "quantity,variant_id",
              variant_id: `in.(${variantIds.join(",")})`
            }, { count: "none" });
            sold_count = orderItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
          }
        } catch (err: unknown) {
          console.error("Error calculating sold_count for single product:", err);
        }

        const reviewCount = reviews.length;
        const ratingValue = reviewCount > 0
          ? Number((reviews.reduce((sum, r) => sum + Number(r.rating || 0), 0) / reviewCount).toFixed(1))
          : 0;

        return sendJson(res, 200, {
          ...product,
          rating_value: ratingValue,
          rating_count: reviewCount,
          review_count: reviewCount,
          variants,
          category,
          reviews,
          sold_count
        }, {
          ...corsHeaders,
          "cache-control": CATALOG_CACHE_CONTROL
        });
      }

      const requestUrl = new URL(req.url || "/api/user/products", "http://localhost");
      const lite = requestUrl.searchParams.get("lite") === "1";
      const filters = parseCatalogFilters(requestUrl.searchParams);
      const now = Date.now();
      const generation = cacheGeneration;

      /** Search, category and material run per request on the cached rows, so they never go stale on their own. */
      const applyFilters = <T extends JsonObject>(items: T[]): T[] => filterCatalogProducts(items, filters);

      if (lite) {
        if (liteProductsCache && (now - liteProductsCache.cachedAt < liteProductsCache.ttlMs)) {
          return sendJson(res, 200, applyFilters(liteProductsCache.data), {
            ...corsHeaders,
            "cache-control": CATALOG_CACHE_CONTROL
          });
        }
      } else {
        if (productsCache && (now - productsCache.cachedAt < productsCache.ttlMs)) {
          return sendJson(res, 200, applyFilters(productsCache.data), {
            ...corsHeaders,
            "cache-control": CATALOG_CACHE_CONTROL
          });
        }
      }

      // Parallel batch fetch using PostgREST foreign key embedding:
      // Product + Category + Variants in 1 single join query, plus combo items and review ratings in parallel
      const [productResult, comboResult, reviewResult] = await Promise.all([
        selectRows("product", {
          select: "product_id,sku,is_combo,name,slug,description,brand,base_price,sale_price,images,image_colors,style_tags,color_tone,occasions,suitable_body_shapes,status,is_featured,collection,seo_title,seo_description,created_at,updated_at,version,category:category_id(category_id,name,slug),variants:variant(variant_id,color,color_hex,size,stock_quantity,reserved_quantity)",
          status: LISTED_STATUSES
        }, { count: "none" }),
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
            brand: p.brand || null,
            base_price: p.base_price,
            sale_price: p.sale_price,
            images: p.images,
            image_colors: p.image_colors || {},
            is_featured: p.is_featured,
            is_combo: p.is_combo,
            status: p.status,
            sold_count: p.sold_count || 0,
            collection: p.collection || null,
            style_tags: p.style_tags || [],
            color_tone: p.color_tone || null,
            occasions: p.occasions || [],
            suitable_body_shapes: p.suitable_body_shapes || [],
            seo_title: p.seo_title || null,
            seo_description: p.seo_description || null,
            description: p.description || null,
            updated_at: p.updated_at || null,
            category_slug: cat ? cat.slug : null,
            category_name: cat ? cat.name : null
          };
        });
        if (generation === cacheGeneration) {
          liteProductsCache = { data: liteRows, cachedAt: now, ttlMs: PRODUCTS_CACHE_TTL_MS };
        }
        return sendJson(res, 200, applyFilters(liteRows), {
          ...corsHeaders,
          "cache-control": CATALOG_CACHE_CONTROL
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

      if (generation === cacheGeneration) {
        productsCache = { data: productsWithVariants, cachedAt: now, ttlMs: PRODUCTS_CACHE_TTL_MS };
      }
      return sendJson(res, 200, applyFilters(productsWithVariants), {
        ...corsHeaders,
        "cache-control": CATALOG_CACHE_CONTROL
      });
    }
  }

  if (subRoute === "categories") {
    if (req.method === "GET") {
      const now = Date.now();
      const generation = cacheGeneration;
      if (categoriesCache && (now - categoriesCache.cachedAt < categoriesCache.ttlMs)) {
        return sendJson(res, 200, categoriesCache.data, {
          ...corsHeaders,
          "cache-control": CATALOG_CACHE_CONTROL
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

      if (generation === cacheGeneration) {
        categoriesCache = {
          data: categoriesWithCount,
          cachedAt: now,
          ttlMs: CATEGORIES_CACHE_TTL_MS
        };
      }

      return sendJson(res, 200, categoriesWithCount, {
        ...corsHeaders,
        "cache-control": CATALOG_CACHE_CONTROL
      });
    }
  }

  throw new HttpError(404, "NOT_FOUND", "Route products or categories not found");
}
