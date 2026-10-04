import { returnReasonLabel } from "../returns/return-constants.js";
import { hasGuestOrderAccess } from "./order-access.js";
import { HttpError } from "../http.js";
import { returnWindowOpen } from "./return-window.js";
import { asJsonObject, asNumber, asString, type JsonObject, type UserProfile } from "../types.js";
import type { UserReturnsRepository } from "./returns-repository.js";

const RESTRICTED_CATEGORY_NAMES = ["Phụ kiện"];
const RESTRICTED_CATEGORY_SLUGS = ["phu-kien"];

/** U2-02: mỗi `order_item` chỉ được xử lý đổi/trả tối đa 2 lần, tính trên cả đơn, không phải trên toàn bộ lịch sử khách. */
const MAX_RETURN_ATTEMPTS_PER_ITEM = 2;

function requireDeliveredWithinWindow(order: JsonObject): void {
  if (asString(order.status) !== "delivered") {
    throw new HttpError(400, "BAD_REQUEST", "Đơn hàng phải hoàn thành (giao thành công) mới được yêu cầu đổi trả");
  }
  const deliveryDate = order.delivered_at
    ? new Date(String(order.delivered_at))
    : new Date(String(order.updated_at || order.created_at));
  if (!returnWindowOpen(deliveryDate, new Date())) {
    throw new HttpError(400, "RETURN_WINDOW_CLOSED", "Quá thời hạn đổi/trả (30 ngày kể từ khi giao hàng)");
  }
}

/**
 * Kiểm từng item khách chọn: thuộc đúng đơn, không thuộc danh mục hạn chế, chưa hết lượt
 * (U2-02) và chưa vượt số lượng đã mua (U2-12). Dùng chung cho cả member và guest vì hai
 * nhánh áp cùng rule trên cùng dữ liệu `order_item`/`return_item`.
 */
async function validateItemsAgainstOrder(
  repository: UserReturnsRepository,
  order: JsonObject,
  rawItems: unknown[]
): Promise<JsonObject[]> {
  const validated: JsonObject[] = [];
  const seen = new Set<string>();
  const existingReturns = await repository.listReturnsForOrder(order.order_id);

  for (const rawItem of rawItems) {
    const item = asJsonObject(rawItem);
    const itemId = asString(item.order_item_id);
    if (!itemId || seen.has(itemId) || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1) throw new HttpError(422,"INVALID_RETURN_ITEMS","Select each item once with a positive integer quantity");
    seen.add(itemId);
    const orderItem = await repository.findOrderItem(item.order_item_id);
    if (!orderItem || orderItem.order_id !== order.order_id) {
      throw new HttpError(400, "BAD_REQUEST", "Sản phẩm không thuộc đơn hàng này");
    }

    const variant = await repository.findVariant(orderItem.variant_id);
    if (variant) {
      const product = await repository.findProduct(variant.product_id);
      if (product) {
        const category = await repository.findCategory(product.category_id);
        if (
          category &&
          (RESTRICTED_CATEGORY_NAMES.includes(asString(category.name)) ||
            RESTRICTED_CATEGORY_SLUGS.includes(asString(category.slug)))
        ) {
          throw new HttpError(400, "BAD_REQUEST", `Sản phẩm ${asString(product.name)} thuộc danh mục hạn chế đổi trả của Velura`);
        }
      }
    }

    let alreadyReturnedQty = 0;
    let activeAttempts = 0;
    for (const existing of existingReturns) {
      if (["CANCELLED","CANCELLED","CANCELLED"].includes(asString(existing.status))) continue;
      const rItems = await repository.listReturnItemsForOrderItem(existing.return_id, item.order_item_id);
      if (!rItems.length) continue;
      activeAttempts += 1;
      for (const ri of rItems) alreadyReturnedQty += Number(ri.quantity);
    }

    if (activeAttempts >= MAX_RETURN_ATTEMPTS_PER_ITEM) {
      throw new HttpError(400, "RETURN_LIMIT_REACHED", "Đã sử dụng hết số lượt đổi/trả cho sản phẩm này");
    }
    if (alreadyReturnedQty + Number(item.quantity) > Number(orderItem.quantity)) {
      throw new HttpError(400, "BAD_REQUEST", "Số lượng đổi trả vượt quá số lượng đã mua");
    }

        const replacementId = asString(item.replacement_variant_id);
    if (replacementId) {
      const replacement = await repository.findVariant(replacementId);
      if (!variant || !replacement || replacement.product_id !== variant.product_id) throw new HttpError(422,"EXCHANGE_SAME_PRODUCT_REQUIRED","Replacement must be a variant of the same product");
    }
    validated.push({ order_item_id: item.order_item_id, quantity: item.quantity,...(replacementId ? {replacement_variant_id:replacementId} : {}) });
  }

  return validated;
}

/**
 * Create/list/cancel use-cases consumed by `handleReturnsRoute`.
 */
export function createUserReturnsService(repository: UserReturnsRepository) {
  return {
    async createForMember(profile: UserProfile, body: JsonObject) {
      const { order_id, return_type, description, evidence_images, items } = body;
      if (!order_id || !return_type || !Array.isArray(items) || !items.length) {
        throw new HttpError(400, "BAD_REQUEST", "Thiếu thông tin yêu cầu đổi trả");
      }

      const order = await repository.findOrderById(asString(order_id));
      if (!order || order.user_id !== profile.user_id) {
        throw new HttpError(403, "FORBIDDEN", "Đơn hàng không hợp lệ");
      }
      requireDeliveredWithinWindow(order);
      const reason = returnReasonLabel(asString(body.reason_code || body.reasonCode));
      const intake = {description:[reason,asString(description)].filter(Boolean).join(". "),images:Array.isArray(evidence_images) ? evidence_images.filter(value => typeof value === "string" && (value.startsWith("https://") || value.startsWith("data:image/"))).slice(0,5) : []};
      if (!["refund","exchange"].includes(asString(return_type))) throw new HttpError(422,"INVALID_RETURN_TYPE","Choose refund or exchange");
      const validatedItems = await validateItemsAgainstOrder(repository, order, items);

      const trackingReturnCode = "RET" + Date.now().toString().slice(-8).toUpperCase();
      if (repository.createReturnBundle) return repository.createReturnBundle({order_id:order.order_id,user_id:order.user_id,return_type,description:intake.description,evidence_images:intake.images},validatedItems);
      const newReturn = await repository.insertReturn({
        order_id,
        user_id: profile.user_id,
        return_type,
        description: description || null,
        evidence_images: evidence_images || null,
        status: "REQUESTED",
        tracking_return_code: trackingReturnCode,
        created_at: new Date().toISOString()
      });

      const returnItems: JsonObject[] = [];
      for (const item of validatedItems) {
        returnItems.push(
          await repository.insertReturnItem({
            return_id: newReturn.return_id,
            order_item_id: item.order_item_id,
            quantity: item.quantity
          })
        );
      }

      return { ...newReturn, items: returnItems };
    },

    /**
     * Nhánh khách vãng lai: xác thực bằng khớp SĐT/email với đơn, không qua OTP. Hành vi giữ
     * nguyên như trước khi tách layer (KAN-32 chỉ tách code, không đổi bảo mật nhánh này —
     * OTP hoá guest-return là việc khác).
     */
    async createForGuest(body: JsonObject) {
      const cleanCode = String(body.order_code || "").trim().toUpperCase();
      const cleanContact = String(body.contact || body.phone || body.email || "").trim();
      const { return_type, description, evidence_images, items } = body;
      if (!cleanCode || !return_type || !Array.isArray(items) || !items.length) {
        throw new HttpError(400, "BAD_REQUEST", "Thiếu thông tin yêu cầu đổi trả (mã đơn, liên hệ, loại đổi trả hoặc sản phẩm)");
      }

      let order = await repository.findOrderByCode(cleanCode);
      if (!order && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanCode)) {
        order = await repository.findOrderById(cleanCode);
      }
      if (!order) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");

      if (!hasGuestOrderAccess(order, body)) throw new HttpError(404,"NOT_FOUND","Order not found");

      requireDeliveredWithinWindow(order);
      const validatedItems = await validateItemsAgainstOrder(repository, order, items);

      const trackingReturnCode = "RT" + Date.now().toString().slice(-8).toUpperCase();
      const newReturn = await repository.insertReturn({
        order_id: order.order_id,
        user_id: order.user_id || null,
        return_type,
        status: "REQUESTED",
        tracking_return_code: trackingReturnCode,
        reason: description || "Khách hàng yêu cầu đổi trả",
        description: description || null,
        evidence_images: Array.isArray(evidence_images) ? evidence_images : [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      for (const item of validatedItems) {
        await repository.insertReturnItem({
          return_id: newReturn.return_id,
          order_item_id: item.order_item_id,
          quantity: item.quantity
        });
      }

      return newReturn;
    },

    /** Lists return requests only after a signed same-phone session authorizes the order. */
    async listForGuest(body: JsonObject) {
      const order = await repository.findOrderById(asString(body.order_id));
      if (!order || !hasGuestOrderAccess(order, body)) throw new HttpError(404,"NOT_FOUND","Order not found");
      const rows = await repository.listReturnsForOrder(order.order_id);
      const populated: JsonObject[] = [];
      for (const ret of rows) populated.push({...ret, order_code:order.order_code,items:await repository.listReturnItemsForReturn(ret.return_id)});
      return populated;
    },
    /** Cancels only a request bound to the verified order and its current version. */
    async cancelForGuest(body: JsonObject) {
      const ret = await repository.findReturnById(body.return_id);
      const order = ret ? await repository.findOrderById(asString(ret.order_id)) : null;
      if (!ret || !order || !hasGuestOrderAccess(order, body)) throw new HttpError(404,"NOT_FOUND","Order not found");
      const version = Number(body.expectedVersion);
      if (!Number.isInteger(version) || version !== Number(ret.version)) throw new HttpError(409,"VERSION_CONFLICT","Return changed");
      if (!["REQUESTED","CONTACTING","WAITING_RETURN"].includes(asString(ret.status))) throw new HttpError(422,"INVALID_TRANSITION","Return has already been handed off");
      const changed = await repository.updateReturn(ret.return_id,{status:"CANCELLED",version:version+1,resolved_at:new Date().toISOString(),rejection_reason:"Customer cancelled"},version);
      if (!changed[0]) throw new HttpError(409,"VERSION_CONFLICT","Return changed");
      return changed[0];
    },
    async cancelForMember(profile: UserProfile, returnId: unknown, rawExpectedVersion: unknown) {
      if (!returnId) throw new HttpError(400, "BAD_REQUEST", "Thiếu return_id");
      const expectedVersion = asNumber(rawExpectedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        throw new HttpError(422, "EXPECTED_VERSION_REQUIRED", "Thiếu phiên bản yêu cầu đổi/trả");
      }
      const ret = await repository.findReturnById(returnId);
      if (!ret) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy yêu cầu đổi trả");
      if (ret.user_id !== profile.user_id) throw new HttpError(403, "FORBIDDEN", "Không có quyền thực hiện");
      if (!["REQUESTED", "WAITING_RETURN"].includes(asString(ret.status))) {
        throw new HttpError(
          400,
          "BAD_REQUEST",
          "Chỉ có thể hủy yêu cầu khi đang ở trạng thái Chờ xác nhận hoặc Đã duyệt hồ sơ (chưa gửi hàng)"
        );
      }
      if (asNumber(ret.version) !== expectedVersion) {
        throw new HttpError(409, "VERSION_CONFLICT", "Yêu cầu đổi/trả đã thay đổi, vui lòng tải lại");
      }
      const updated = await repository.updateReturn(returnId, {
        status: "CANCELLED",
        rejection_reason: "Đã hủy bởi khách hàng",
        resolved_at: new Date().toISOString(),
        version: expectedVersion + 1
      }, expectedVersion);
      if (!updated[0]) {
        throw new HttpError(409, "VERSION_CONFLICT", "Yêu cầu đổi/trả đã thay đổi, vui lòng tải lại");
      }
      return updated[0];
    },

    async listForMember(profile: UserProfile, orderId: string | null) {
      const returns = await repository.listReturnsForUser(profile.user_id, orderId || undefined);
      const populated: JsonObject[] = [];
      for (const ret of returns) {
        const order = await repository.findOrderById(asString(ret.order_id));
        const items = await repository.listReturnItemsForReturn(ret.return_id);
        const itemsWithDetails: JsonObject[] = [];
        for (const ri of items) {
          const orderItem = await repository.findOrderItem(ri.order_item_id);
          itemsWithDetails.push({
            ...ri,
            variant_id: orderItem ? orderItem.variant_id : null,
            product_name: orderItem ? orderItem.product_name : "Sản phẩm",
            product_image: orderItem ? orderItem.product_image : null,
            unit_price: orderItem ? orderItem.unit_price : 0
          });
        }
        populated.push({ ...ret, order_code: order ? order.order_code : null, items: itemsWithDetails });
      }
      populated.sort((a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime());
      return populated;
    }
  };
}

export type UserReturnsService = ReturnType<typeof createUserReturnsService>;
