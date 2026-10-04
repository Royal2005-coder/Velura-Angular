import { callRpc, selectOne, selectRows, insertRow, updateRows } from "../supabase.js";
import { asJsonObject, type JsonObject } from "../types.js";

/**
 * Supabase-only accessors for customer-facing return/exchange requests. No business rule
 * lives here — ownership, window and quota checks belong to `returns-service.ts` so they can
 * run against a fake repository in tests.
 */
export interface UserReturnsRepository {
  /** Atomically creates a request while locking item quotas on the original order. */
  createReturnBundle?(payload:JsonObject,items:JsonObject[]):Promise<JsonObject>;
  findOrderByCode(code: string): Promise<JsonObject | null>;
  findOrderById(orderId: string): Promise<JsonObject | null>;
  findOrderItem(itemId: unknown): Promise<JsonObject | null>;
  findVariant(variantId: unknown): Promise<JsonObject | null>;
  findProduct(productId: unknown): Promise<JsonObject | null>;
  findCategory(categoryId: unknown): Promise<JsonObject | null>;
  listReturnsForOrder(orderId: unknown): Promise<JsonObject[]>;
  listReturnItemsForOrderItem(returnId: unknown, orderItemId: unknown): Promise<JsonObject[]>;
  listReturnItemsForReturn(returnId: unknown): Promise<JsonObject[]>;
  insertReturn(payload: JsonObject): Promise<JsonObject>;
  insertReturnItem(payload: JsonObject): Promise<JsonObject>;
  findReturnById(returnId: unknown): Promise<JsonObject | null>;
  updateReturn(returnId: unknown, payload: JsonObject, expectedVersion?: number): Promise<JsonObject[]>;
  listReturnsForUser(userId: string, orderId?: string): Promise<JsonObject[]>;
}

export function createUserReturnsRepository(): UserReturnsRepository {
  return {
    createReturnBundle: async(payload,items)=>asJsonObject(await callRpc("velura_create_return_request",{p_payload:payload,p_items:items})),
    findOrderByCode: (code) => selectOne("orders", { order_code: `eq.${code}` }),
    findOrderById: (orderId) => selectOne("orders", { order_id: `eq.${orderId}` }),
    findOrderItem: (itemId) => selectOne("order_item", { item_id: `eq.${itemId}` }),
    findVariant: (variantId) => selectOne("variant", { variant_id: `eq.${variantId}` }),
    findProduct: (productId) => selectOne("product", { product_id: `eq.${productId}` }),
    findCategory: (categoryId) => selectOne("category", { category_id: `eq.${categoryId}` }),

    async listReturnsForOrder(orderId) {
      const { rows } = await selectRows("return_exchange", { order_id: `eq.${orderId}` });
      return rows;
    },

    async listReturnItemsForOrderItem(returnId, orderItemId) {
      const { rows } = await selectRows("return_item", {
        return_id: `eq.${returnId}`,
        order_item_id: `eq.${orderItemId}`
      });
      return rows;
    },

    async listReturnItemsForReturn(returnId) {
      const { rows } = await selectRows("return_item", { return_id: `eq.${returnId}` });
      return rows;
    },

    async insertReturn(payload) {
      return asJsonObject(await insertRow("return_exchange", payload));
    },

    async insertReturnItem(payload) {
      return asJsonObject(await insertRow("return_item", payload));
    },

    findReturnById: (returnId) => selectOne("return_exchange", { return_id: `eq.${returnId}` }),

    async updateReturn(returnId, payload, expectedVersion) {
      const filters: Record<string, string> = { return_id: `eq.${returnId}` };
      if (expectedVersion !== undefined) filters.version = `eq.${expectedVersion}`;
      const rows = await updateRows("return_exchange", filters, payload);
      return rows.map(asJsonObject);
    },

    async listReturnsForUser(userId, orderId) {
      const queryParams: Record<string, string> = { user_id: `eq.${userId}` };
      if (orderId) queryParams.order_id = `eq.${orderId}`;
      const { rows } = await selectRows("return_exchange", queryParams);
      return rows;
    }
  };
}

/**
 * Sum refundable amount for a return request from its line items.
 *
 * Không có route nào gọi hai hàm này và `createExchangeOrder` nữa — giữ nguyên, chỉ dời từ
 * `returns.ts` sang đây khi tách layer, không đổi logic (tạo đơn đổi hàng qua API khách vẫn
 * là việc khác, ngoài KAN-32).
 */
export async function calculateReturnAmount(returnId: unknown): Promise<number> {
  const { rows: items } = await selectRows("return_item", { return_id: `eq.${returnId}` });
  let total = 0;
  for (const item of items) {
    const orderItem = await selectOne("order_item", { item_id: `eq.${item.order_item_id}` });
    if (orderItem) {
      total += Number(orderItem.unit_price) * Number(item.quantity);
    }
  }
  return total;
}

/**
 * Mark the order payment as refunded with the given amount.
 */
export async function processRefundPayment(orderId: unknown, refundAmount: unknown): Promise<void> {
  const payment = await selectOne("payment", { order_id: `eq.${orderId}` });
  if (payment) {
    await updateRows("payment", { payment_id: `eq.${payment.payment_id}` }, {
      payment_status: "refunded",
      refund_amount: refundAmount,
      refund_at: new Date().toISOString()
    });
  }
}

/**
 * Create a replacement order from an approved exchange request.
 */
export async function createExchangeOrder(ret: JsonObject, exchangeVariantId: unknown): Promise<unknown> {
  const originalOrder = await selectOne("orders", { order_id: `eq.${ret.order_id}` });
  if (!originalOrder) {
    throw new Error("Không tìm thấy đơn hàng gốc");
  }

  const { rows: returnItems } = await selectRows("return_item", { return_id: `eq.${ret.return_id}` });
  if (returnItems.length === 0) {
    throw new Error("Không tìm thấy sản phẩm trả về");
  }

  let targetVariantId = exchangeVariantId;
  if (!targetVariantId) {
    const firstReturnItem = returnItems[0];
    const originalOrderItem = await selectOne("order_item", { item_id: `eq.${firstReturnItem.order_item_id}` });
    if (originalOrderItem) {
      targetVariantId = originalOrderItem.variant_id;
    }
  }

  if (!targetVariantId) {
    throw new Error("Không xác định được sản phẩm đổi mới");
  }

  const v = await selectOne("variant", { variant_id: `eq.${targetVariantId}` });
  if (!v) {
    throw new Error("Variant đổi mới không tồn tại");
  }

  const p = await selectOne("product", { product_id: `eq.${v.product_id}` });
  if (!p) {
    throw new Error("Product đổi mới không tồn tại");
  }

  const firstReturnItem = returnItems[0];
  const originalOrderItem = await selectOne("order_item", { item_id: `eq.${firstReturnItem.order_item_id}` });
  const originalUnitPrice = originalOrderItem ? Number(originalOrderItem.unit_price) : 0;
  const newUnitPrice = Number(p.sale_price);

  const qty = Number(firstReturnItem.quantity);
  const originalTotal = originalUnitPrice * qty;
  const newTotal = newUnitPrice * qty;

  const priceDiff = newTotal - originalTotal;

  let orderStatus = "confirmed";
  let paymentStatus = "paid";

  if (priceDiff > 0) {
    orderStatus = "pending";
    paymentStatus = "pending";
  }

  const trackingCode = "EXC" + Date.now().toString().slice(-8).toUpperCase();
  const exchangeOrder = asJsonObject(await insertRow("orders", {
    user_id: ret.user_id,
    status: orderStatus,
    shipping_name: originalOrder.shipping_name,
    shipping_phone: originalOrder.shipping_phone,
    shipping_address: originalOrder.shipping_address,
    shipping_fee: 0,
    discount_amount: priceDiff > 0 ? originalTotal : newTotal,
    subtotal: newTotal,
    total_amount: priceDiff > 0 ? priceDiff : 0,
    payment_method: originalOrder.payment_method,
    tracking_code: trackingCode,
    internal_note: `Đơn hàng đổi mới từ yêu cầu ${ret.tracking_return_code}. Chênh lệch: ${priceDiff}₫`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }));

  const images = Array.isArray(p.images) ? p.images : [];

  await insertRow("order_item", {
    order_id: exchangeOrder.order_id,
    variant_id: targetVariantId,
    product_name: p.name,
    product_image: images[0] || null,
    quantity: qty,
    unit_price: newUnitPrice,
    subtotal_item: newTotal
  });

  await insertRow("payment", {
    order_id: exchangeOrder.order_id,
    payment_method: originalOrder.payment_method,
    amount: priceDiff > 0 ? priceDiff : 0,
    payment_status: paymentStatus,
    created_at: new Date().toISOString()
  });

  if (priceDiff < 0) {
    await processRefundPayment(ret.order_id, Math.abs(priceDiff));
  }

  return exchangeOrder;
}
