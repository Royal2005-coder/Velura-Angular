import { HttpError, readJson, sendJson } from "../http.js";
import { selectOne, selectRows, insertRow, updateRows } from "../supabase.js";
import { requireUserAuth } from "./auth.js";
import { parseUtcDate } from "./orders.js";

// Calculate total amount to refund for a return request
export async function calculateReturnAmount(returnId) {
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

// Process refund status in payment
export async function processRefundPayment(orderId, refundAmount) {
  const payment = await selectOne("payment", { order_id: `eq.${orderId}` });
  if (payment) {
    await updateRows("payment", { payment_id: `eq.${payment.payment_id}` }, {
      payment_status: "refunded",
      refund_amount: refundAmount,
      refund_at: new Date().toISOString()
    });
  }
}

// Create new exchange order
export async function createExchangeOrder(ret, exchangeVariantId) {
  const originalOrder = await selectOne("orders", { order_id: `eq.${ret.order_id}` });
  if (!originalOrder) {
    throw new Error("Không tìm thấy đơn hàng gốc");
  }

  // Get returned items
  const { rows: returnItems } = await selectRows("return_item", { return_id: `eq.${ret.return_id}` });
  if (returnItems.length === 0) {
    throw new Error("Không tìm thấy sản phẩm trả về");
  }

  // Find the variant we are exchanging to (or default to the returned variant)
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

  // Calculate pricing
  const firstReturnItem = returnItems[0];
  const originalOrderItem = await selectOne("order_item", { item_id: `eq.${firstReturnItem.order_item_id}` });
  const originalUnitPrice = originalOrderItem ? Number(originalOrderItem.unit_price) : 0;
  const newUnitPrice = Number(p.sale_price);

  const qty = firstReturnItem.quantity;
  const originalTotal = originalUnitPrice * qty;
  const newTotal = newUnitPrice * qty;

  const priceDiff = newTotal - originalTotal; // positive if new is more expensive

  let orderStatus = "confirmed";
  let paymentStatus = "paid";
  
  if (priceDiff > 0) {
    orderStatus = "pending"; // waiting for additional payment
    paymentStatus = "pending";
  }

  // Create new order
  const trackingCode = "EXC" + Date.now().toString().slice(-8).toUpperCase();
  const exchangeOrder = await insertRow("orders", {
    user_id: ret.user_id,
    status: orderStatus,
    shipping_name: originalOrder.shipping_name,
    shipping_phone: originalOrder.shipping_phone,
    shipping_address: originalOrder.shipping_address,
    shipping_fee: 0, // exchange is free shipping
    discount_amount: priceDiff > 0 ? originalTotal : newTotal,
    subtotal: newTotal,
    total_amount: priceDiff > 0 ? priceDiff : 0,
    payment_method: originalOrder.payment_method,
    tracking_code: trackingCode,
    internal_note: `Đơn hàng đổi mới từ yêu cầu ${ret.tracking_return_code}. Chênh lệch: ${priceDiff}₫`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  // Create order item for the exchange order
  await insertRow("order_item", {
    order_id: exchangeOrder.order_id,
    variant_id: targetVariantId,
    product_name: p.name,
    product_image: (p.images && p.images[0]) || null,
    quantity: qty,
    unit_price: newUnitPrice,
    subtotal_item: newTotal
  });

  // Create payment record
  await insertRow("payment", {
    order_id: exchangeOrder.order_id,
    payment_method: originalOrder.payment_method,
    amount: priceDiff > 0 ? priceDiff : 0,
    payment_status: paymentStatus,
    created_at: new Date().toISOString()
  });

  // If priceDiff is negative, refund the difference
  if (priceDiff < 0) {
    await processRefundPayment(ret.order_id, Math.abs(priceDiff));
  }

  return exchangeOrder;
}


export async function handleReturnsRoute(req, res, action, corsHeaders, context) {
  const profile = requireUserAuth(context);

  // POST /api/user/returns/cancel
  if (req.method === "POST" && action === "cancel") {
    const body = await readJson(req);
    const { return_id } = body;
    if (!return_id) {
      throw new HttpError(400, "BAD_REQUEST", "Thiếu return_id");
    }

    const ret = await selectOne("return_exchange", { return_id: `eq.${return_id}` });
    if (!ret) {
      throw new HttpError(404, "NOT_FOUND", "Không tìm thấy yêu cầu đổi trả");
    }
    if (ret.user_id !== profile.user_id) {
      throw new HttpError(403, "FORBIDDEN", "Không có quyền thực hiện");
    }

    // Check current status
    if (!["pending", "approved"].includes(ret.status)) {
      throw new HttpError(400, "BAD_REQUEST", "Chỉ có thể hủy yêu cầu khi đang ở trạng thái Chờ xác nhận hoặc Đã duyệt hồ sơ (chưa gửi hàng)");
    }

    const updated = await updateRows("return_exchange", { return_id: `eq.${return_id}` }, {
      status: "rejected",
      rejection_reason: "Đã hủy bởi khách hàng",
      resolved_at: new Date().toISOString()
    });

    return sendJson(res, 200, { success: true, return: updated[0] }, corsHeaders);
  }

  // POST /api/user/returns
  if (req.method === "POST" && !action) {
    const body = await readJson(req);
    const { order_id, return_type, description, evidence_images, items } = body;

    if (!order_id || !return_type || !items || !items.length) {
      throw new HttpError(400, "BAD_REQUEST", "Thiếu thông tin yêu cầu đổi trả");
    }

    // Check if order belongs to user
    const order = await selectOne("orders", { order_id: `eq.${order_id}` });
    if (!order || order.user_id !== profile.user_id) {
      throw new HttpError(403, "FORBIDDEN", "Đơn hàng không hợp lệ");
    }

    // Enforce order status check
    if (!["delivered", "completed"].includes(order.status)) {
      throw new HttpError(400, "BAD_REQUEST", "Đơn hàng phải hoàn thành mới được yêu cầu đổi trả");
    }

    // RET-01 Time Check (2 days / 48 hours)
    const deliveryDate = order.delivered_at ? new Date(order.delivered_at) : new Date(order.updated_at || order.created_at);
    const now = new Date();
    const diffHours = (now - deliveryDate) / (1000 * 60 * 60);
    if (diffHours > 48) {
      throw new HttpError(400, "BAD_REQUEST", "Quá thời hạn đổi/trả (2 ngày)");
    }

    // Perform category and quantity validation
    const validatedItems = [];
    const { rows: existingReturns } = await selectRows("return_exchange", { order_id: `eq.${order_id}` });

    for (const item of items) {
      const orderItem = await selectOne("order_item", { item_id: `eq.${item.order_item_id}` });
      if (!orderItem || orderItem.order_id !== order_id) {
        throw new HttpError(400, "BAD_REQUEST", "Sản phẩm không thuộc đơn hàng này");
      }

      // Category restriction check
      const variant = await selectOne("variant", { variant_id: `eq.${orderItem.variant_id}` });
      if (variant) {
        const product = await selectOne("product", { product_id: `eq.${variant.product_id}` });
        if (product) {
          const category = await selectOne("category", { category_id: `eq.${product.category_id}` });
          if (category && (category.name === "Phụ kiện" || category.slug === "phu-kien")) {
            throw new HttpError(400, "BAD_REQUEST", `Sản phẩm ${product.name} thuộc danh mục hạn chế đổi trả của Velura`);
          }
        }
      }

      // Quantity check
      let alreadyReturnedQty = 0;
      for (const r of existingReturns) {
        if (r.status !== "rejected") {
          const { rows: rItems } = await selectRows("return_item", { return_id: `eq.${r.return_id}`, order_item_id: `eq.${item.order_item_id}` });
          for (const ri of rItems) {
            alreadyReturnedQty += ri.quantity;
          }
        }
      }

      if (alreadyReturnedQty + item.quantity > orderItem.quantity) {
        throw new HttpError(400, "BAD_REQUEST", "Số lượng đổi trả vượt quá số lượng đã mua");
      }

      validatedItems.push({
        order_item_id: item.order_item_id,
        quantity: item.quantity
      });
    }

    const trackingReturnCode = "RET" + Date.now().toString().slice(-8).toUpperCase();

    const newReturn = await insertRow("return_exchange", {
      order_id,
      user_id: profile.user_id,
      return_type,
      description: description || null,
      evidence_images: evidence_images || null,
      status: "pending",
      tracking_return_code: trackingReturnCode,
      created_at: new Date().toISOString()
    });

    const returnItems = [];
    for (const item of validatedItems) {
      const retItem = await insertRow("return_item", {
        return_id: newReturn.return_id,
        order_item_id: item.order_item_id,
        quantity: item.quantity
      });
      returnItems.push(retItem);
    }

    return sendJson(res, 200, {
      success: true,
      return: { ...newReturn, items: returnItems }
    }, corsHeaders);
  }

  // GET /api/user/returns
  if (req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const order_id = url.searchParams.get("order_id");

    let queryParams = { user_id: `eq.${profile.user_id}` };
    if (order_id) {
      queryParams.order_id = `eq.${order_id}`;
    }

    const { rows: returns } = await selectRows("return_exchange", queryParams);
    
    // Populate items
    const populatedReturns = [];
    for (const ret of returns) {
      const { rows: rItems } = await selectRows("return_item", { return_id: `eq.${ret.return_id}` });
      
      const itemsWithDetails = [];
      for (const ri of rItems) {
        const orderItem = await selectOne("order_item", { item_id: `eq.${ri.order_item_id}` });
        itemsWithDetails.push({
          ...ri,
          product_name: orderItem ? orderItem.product_name : "Sản phẩm",
          product_image: orderItem ? orderItem.product_image : null,
          unit_price: orderItem ? orderItem.unit_price : 0
        });
      }
      populatedReturns.push({
        ...ret,
        items: itemsWithDetails
      });
    }

    // Sort descending by created_at
    populatedReturns.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return sendJson(res, 200, {
      success: true,
      returns: populatedReturns
    }, corsHeaders);
  }

  throw new HttpError(404, "NOT_FOUND", "Route returns not found");
}
