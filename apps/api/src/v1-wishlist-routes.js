import { HttpError, readJson, sendJson } from "./http.js";
import {
  addWishlistProductForUser,
  readWishlistProductsForUser,
  removeWishlistProductForUser
} from "./user/wishlist.js";

function requireUserAuth(context) {
  if (!context || !context.profile || !context.profile.user_id) {
    throw new HttpError(401, "UNAUTHORIZED", "Đăng nhập là bắt buộc để thực hiện thao tác này");
  }
  return context.profile;
}

export async function handleWishlistRoute(req, res, parts, corsHeaders, context) {
  const profile = requireUserAuth(context);

  if (req.method === "GET") {
    const { items } = await readWishlistProductsForUser(profile.user_id);
    return sendJson(res, 200, {
      status: "success",
      data: items.map(mapProductForLegacyWishlist)
    }, corsHeaders);
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const wishlist = await addWishlistProductForUser(profile.user_id, body.product_id);
    return sendJson(res, 201, {
      status: "success",
      message: "Đã thêm vào danh sách yêu thích thành công",
      wishlist
    }, corsHeaders);
  }

  if (req.method === "DELETE") {
    const productId = parts[3];
    const wishlist = await removeWishlistProductForUser(profile.user_id, productId);
    return sendJson(res, 200, {
      status: "success",
      message: "Đã xóa khỏi danh sách yêu thích thành công",
      wishlist
    }, corsHeaders);
  }

  throw new HttpError(405, "METHOD_NOT_ALLOWED", "Phương thức không được hỗ trợ");
}

function mapProductForLegacyWishlist(product) {
  return {
    id: product.product_id,
    product: {
      id: product.product_id,
      name: product.name,
      image_url: product.images?.[0] || "",
      price: product.sale_price || product.base_price,
      old_price: product.sale_price && product.base_price > product.sale_price ? product.base_price : null,
      badge: product.is_featured ? "HOT" : "NEW"
    },
    added_at: null
  };
}
