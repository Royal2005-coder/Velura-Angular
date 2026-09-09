import { HttpError, readJson, sendJson } from "../http.js";
import { selectOne, insertRow, updateRows } from "../supabase.js";
import { requireUserAuth } from "./auth.js";

export async function handleCartRoute(req, res, corsHeaders, context) {
  const profile = requireUserAuth(context);

  // GET /api/user/cart
  if (req.method === "GET") {
    const cart = await selectOne("cart", { user_id: `eq.${profile.user_id}` });
    return sendJson(res, 200, { success: true, items: cart ? cart.items : [] }, corsHeaders);
  }

  // POST /api/user/cart
  if (req.method === "POST") {
    const body = await readJson(req);
    const { items } = body;

    if (!Array.isArray(items)) {
      throw new HttpError(400, "BAD_REQUEST", "items phải là một mảng");
    }

    // Stock verification for each item
    const warnings = [];
    const validatedItems = [];
    for (const item of items) {
      const normalizedVariantId = normalizeVariantId(item.variant_id);
      if (!normalizedVariantId) {
        warnings.push(`Sản phẩm '${item.product_name || "Sản phẩm"}' có mã biến thể không hợp lệ và đã bị xóa khỏi giỏ hàng.`);
        continue;
      }
      item.variant_id = normalizedVariantId;

      const variant = await selectOne("variant", { variant_id: `eq.${normalizedVariantId}` });
      if (!variant) {
        throw new HttpError(400, "NOT_FOUND", `Không tìm thấy biến thể sản phẩm`);
      }
      const availableStock = Math.max(0, variant.stock_quantity - (variant.reserved_quantity || 0));
      if (availableStock <= 0) {
        warnings.push(`Sản phẩm '${item.product_name || "Sản phẩm"} - ${item.color || ""} - ${item.size || ""}' đã hết hàng và bị xóa khỏi giỏ hàng.`);
        continue;
      }
      if (item.quantity > availableStock) {
        warnings.push(`Sản phẩm '${item.product_name || "Sản phẩm"} - ${item.color || ""} - ${item.size || ""}' chỉ còn ${availableStock} sản phẩm khả dụng. Số lượng đã được điều chỉnh.`);
        item.quantity = availableStock;
      }
      validatedItems.push(item);
    }

    const existing = await selectOne("cart", { user_id: `eq.${profile.user_id}` });
    let result;
    if (existing) {
      result = await updateRows("cart", { user_id: `eq.${profile.user_id}` }, {
        items: validatedItems,
        updated_at: new Date().toISOString()
      });
    } else {
      result = await insertRow("cart", {
        user_id: profile.user_id,
        items: validatedItems,
        updated_at: new Date().toISOString()
      });
    }

    return sendJson(res, 200, { success: true, items: validatedItems, warnings }, corsHeaders);
  }

  throw new HttpError(404, "NOT_FOUND", "Route cart not found");
}

function normalizeVariantId(value) {
  const rawValue = String(value || "").trim();
  const prefixedUuid = rawValue.match(/^var-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
  if (prefixedUuid) {
    return prefixedUuid[1];
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawValue)) {
    return rawValue;
  }
  return "";
}
