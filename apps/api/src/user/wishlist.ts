import { HttpError, readJson, sendJson } from "../http.js";
import { selectOne, selectRows, updateRows } from "../supabase.js";
import { requireUserAuth } from "./auth.js";
import {
  asJsonObject,
  isJsonObject,
  type AuthContext,
  type HeaderMap,
  type HttpRequest,
  type HttpResponse,
  type JsonObject
} from "../types.js";

/**
 * Authenticated wishlist read, add, and remove.
 */
export async function handleWishlistRoute(
  req: HttpRequest,
  res: HttpResponse,
  corsHeaders: HeaderMap,
  context: AuthContext
): Promise<void> {
  const profile = requireUserAuth(context);

  if (req.method === "GET") {
    const wishlist = await getWishlistProductIds(profile.user_id);
    const items = await hydrateWishlistProducts(wishlist);
    return sendJson(res, 200, { success: true, wishlist, items }, corsHeaders);
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const productId = normalizeProductId(body.product_id);
    if (!productId) {
      throw new HttpError(400, "BAD_REQUEST", "product_id là bắt buộc");
    }

    await ensureProductExists(productId);
    const wishlist = await getWishlistProductIds(profile.user_id);
    const nextWishlist = wishlist.includes(productId) ? wishlist : [...wishlist, productId];
    await saveWishlistProductIds(profile.user_id, nextWishlist);

    return sendJson(res, 200, { success: true, wishlist: nextWishlist }, corsHeaders);
  }

  if (req.method === "DELETE") {
    const productId = await getProductIdFromDeleteRequest(req);
    if (!productId) {
      throw new HttpError(400, "BAD_REQUEST", "product_id là bắt buộc");
    }

    const wishlist = await getWishlistProductIds(profile.user_id);
    const nextWishlist = wishlist.filter((id) => id !== productId);
    await saveWishlistProductIds(profile.user_id, nextWishlist);

    return sendJson(res, 200, { success: true, wishlist: nextWishlist }, corsHeaders);
  }

  throw new HttpError(405, "METHOD_NOT_ALLOWED", "Phương thức wishlist không được hỗ trợ");
}

/**
 * Load a member's wishlist ids and on-sale product rows.
 */
export async function readWishlistProductsForUser(userId: string): Promise<{
  wishlist: string[];
  items: JsonObject[];
}> {
  const wishlist = await getWishlistProductIds(userId);
  const items = await hydrateWishlistProducts(wishlist);
  return { wishlist, items };
}

/**
 * Add a product to a member's wishlist and return the next id list.
 */
export async function addWishlistProductForUser(userId: string, productId: unknown): Promise<string[]> {
  const normalizedProductId = normalizeProductId(productId);
  if (!normalizedProductId) {
    throw new HttpError(400, "BAD_REQUEST", "product_id là bắt buộc");
  }
  await ensureProductExists(normalizedProductId);
  const wishlist = await getWishlistProductIds(userId);
  const nextWishlist = wishlist.includes(normalizedProductId) ? wishlist : [...wishlist, normalizedProductId];
  await saveWishlistProductIds(userId, nextWishlist);
  return nextWishlist;
}

/**
 * Remove a product from a member's wishlist and return the next id list.
 */
export async function removeWishlistProductForUser(userId: string, productId: unknown): Promise<string[]> {
  const normalizedProductId = normalizeProductId(productId);
  if (!normalizedProductId) {
    throw new HttpError(400, "BAD_REQUEST", "product_id là bắt buộc");
  }
  const wishlist = await getWishlistProductIds(userId);
  const nextWishlist = wishlist.filter((id) => id !== normalizedProductId);
  await saveWishlistProductIds(userId, nextWishlist);
  return nextWishlist;
}

async function getWishlistProductIds(userId: string): Promise<string[]> {
  const user = await selectOne("users", {
    select: "user_id,wishlist",
    user_id: `eq.${userId}`
  }, { useAnonKey: true });

  return normalizeWishlist(user?.wishlist);
}

async function saveWishlistProductIds(userId: string, wishlist: unknown): Promise<void> {
  await updateRows("users", { user_id: `eq.${userId}` }, {
    wishlist: normalizeWishlist(wishlist),
    updated_at: new Date().toISOString()
  }, { useAnonKey: true });
}

async function hydrateWishlistProducts(wishlist: unknown): Promise<JsonObject[]> {
  const ids = normalizeWishlist(wishlist);
  if (!ids.length) return [];

  const { rows } = await selectRows("product", {
    product_id: `in.(${ids.join(",")})`,
    status: "eq.on_sale"
  }, { useAnonKey: true });

  const order = new Map(ids.map((id, index) => [id, index]));
  return rows.sort((a, b) => (order.get(String(a.product_id)) ?? 0) - (order.get(String(b.product_id)) ?? 0));
}

async function ensureProductExists(productId: string): Promise<void> {
  const product = await selectOne("product", {
    select: "product_id",
    product_id: `eq.${productId}`,
    status: "eq.on_sale"
  }, { useAnonKey: true });

  if (!product) {
    throw new HttpError(404, "NOT_FOUND", "Không tìm thấy sản phẩm");
  }
}

async function getProductIdFromDeleteRequest(req: HttpRequest): Promise<string> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const queryProductId = normalizeProductId(url.searchParams.get("product_id"));
  if (queryProductId) return queryProductId;

  const body = await readJson(req).catch((): JsonObject => ({}));
  return normalizeProductId(body.product_id);
}

function normalizeWishlist(value: unknown): string[] {
  const rawItems = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const item of rawItems) {
    const id = normalizeProductId(
      typeof item === "object" && item !== null
        ? (isJsonObject(item) ? item.product_id : asJsonObject(item).product_id)
        : item
    );
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

function normalizeProductId(value: unknown): string {
  const id = String(value || "").trim();
  return isUuid(id) ? id : "";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
