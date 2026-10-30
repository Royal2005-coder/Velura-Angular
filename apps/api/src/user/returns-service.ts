import { RETURN_STATUS_LABELS_VI, returnReasonLabel } from "../returns/return-constants.js";
import { classifyReturnPayment, customerRefundReceiver, refundFlowFor, validateRefundReceiver } from "../returns/return-refund-receiver.js";
import { listReturnEvidence, resolveEvidenceRef, storeReturnEvidence, type ReturnEvidenceKind } from "../returns/return-evidence.js";
import { hasGuestOrderAccess } from "./order-access.js";
import { HttpError } from "../http.js";
import { returnWindowOpen } from "./return-window.js";
import { asJsonObject, asNumber, asString, type HttpRequest, type JsonObject, type UserProfile } from "../types.js";
import type { UserReturnsRepository } from "./returns-repository.js";

/** A customer may withdraw a request only while no parcel has been handed to the carrier. */
const CUSTOMER_CANCELLABLE_STATUSES: readonly string[] = ["REQUESTED", "CONTACTING", "WAITING_RETURN"];
/** Packing evidence is only meaningful before the carrier picks the parcel up. */
const CUSTOMER_PACKING_STATUSES: readonly string[] = ["REQUESTED", "CONTACTING", "APPROVED", "WAITING_RETURN"];
const CUSTOMER_VISIBLE_EVIDENCE_KINDS = ["request_photo", "request_video", "packing_photo", "packing_video", "pickup_photo", "pickup_video", "qa_photo", "qa_video"];

const RETURN_INSTRUCTIONS: readonly string[] = [
  "Bạn có thể bổ sung video đóng gói (không bắt buộc): sản phẩm, tem/niêm phong, mã phiếu và kiện hàng đã dán nhãn.",
  "Dán nhãn vận đơn hoàn lên kiện hàng; đưa mã QR trên nhãn cho ĐVVC quét khi lấy hàng.",
  "ĐVVC chụp ảnh kiện hàng nguyên vẹn trước khi mang đi; ảnh này là bằng chứng đối chiếu.",
  "Khi hàng về kho, Velura kiểm tra niêm phong, đúng sản phẩm/số lượng và đối chiếu ảnh/video.",
  "Nếu có sai lệch, Velura mở hồ sơ CSKH kèm toàn bộ bằng chứng hai chiều."
];


/**
 * Customer-facing shape of one return request: the persisted row without CSKH-internal fields, plus what the
 * storefront needs to render it. A request CSKH rejected keeps `cancelled_by = 'admin'` and its `rejection_reason`
 * so the customer sees "Bị từ chối" with the reason; the COD receiving account is masked to its last four digits.
 */
async function customerReturnView(
  repository: UserReturnsRepository,
  ret: JsonObject,
  order: JsonObject | null,
  items: JsonObject[]
): Promise<JsonObject> {
  const {
    admin_note: _adminNote,
    warehouse_proof: _warehouseProof,
    qa_item_receipts: _receipts,
    package_match: _packageMatch,
    seal_intact: _sealIntact,
    qa_note: _qaNote,
    refund_bank_name: _bankName,
    refund_bank_account: _bankAccount,
    refund_bank_holder: _bankHolder,
    ...visible
  } = ret;
  const hasRefundPart = items.some((item) => item.resolution_type === "refund");
  const flow = refundFlowFor(hasRefundPart ? "refund" : ret.return_type, classifyReturnPayment(order?.payment_method, undefined));
  const receiverRequired = flow === "cod_manual";
  const receiver = receiverRequired ? await repository.getRefundReceiver(ret.return_id) : null;
  const status = asString(ret.status);
  return {
    ...visible,
    status_label: RETURN_STATUS_LABELS_VI[status] || status,
    type_label: ret.return_type === "exchange" ? "Đổi hàng" : "Hoàn tiền",
    order_code: order ? order.order_code : null,
    payment_method: order ? order.payment_method : null,
    customer_name: order ? order.shipping_name || null : null,
    customer_phone: order ? order.shipping_phone || null : null,
    customer_address: order ? order.shipping_address || null : null,
    refund_flow: flow,
    refund_receiver: customerRefundReceiver(receiverRequired, receiver),
    can_cancel: CUSTOMER_CANCELLABLE_STATUSES.includes(status),
    can_upload_packing: items.length ? items.some((part) => CUSTOMER_PACKING_STATUSES.includes(asString(part.item_status))) : CUSTOMER_PACKING_STATUSES.includes(status),
    items
  };
}

/**
 * Customer-facing timeline. Raw `return_event.note` can contain CSKH working notes, so the
 * storefront only receives a derived label and the safe shipment facts.
 */
function customerTimeline(events: JsonObject[]): JsonObject[] {
  return events.map((event) => {
    const type = asString(event.event_type) || "status";
    const payload = asJsonObject(event.payload);
    const direction = asString(payload.direction);
    const shipmentStatus = asString(payload.status);
    const newStatus = asString(event.new_status);
    let label = RETURN_STATUS_LABELS_VI[newStatus] || newStatus;
    if (type === "shipment") {
      if (direction === "outbound") {
        label = shipmentStatus === "delivered" ? "Hàng đổi đã giao tới bạn" : "Đã giao hàng đổi cho ĐVVC";
      } else {
        label = shipmentStatus === "label_ready" ? "Đã tạo vận đơn hoàn"
          : shipmentStatus === "delivered" ? "ĐVVC đã giao hàng hoàn về kho"
            : shipmentStatus === "failed" ? "Vận chuyển hoàn gặp sự cố"
              : shipmentStatus === "in_transit" ? "Hàng hoàn đang trên đường về kho"
                : "Đã tạo vận đơn hoàn";
      }
    } else if (type === "pickup") {
      label = "ĐVVC đã lấy hàng hoàn và chụp ảnh niêm phong";
    } else if (type === "carrier") {
      const outbound = direction === "outbound";
      label = shipmentStatus === "delivered"
        ? (outbound ? "ĐVVC xác nhận đã giao hàng đổi" : "ĐVVC xác nhận đã giao hàng hoàn về kho")
        : shipmentStatus === "failed"
          ? (outbound ? "ĐVVC báo giao hàng đổi thất bại" : "ĐVVC báo hoàn hàng thất bại")
          : (outbound ? "ĐVVC cập nhật vận chuyển hàng đổi" : "ĐVVC cập nhật vận chuyển hoàn");
    } else if (type === "customer_evidence") {
      label = "Bạn đã tải bằng chứng đóng gói";
    }
    return {
      return_item_id: event.return_item_id || payload.return_item_id || null,
      event_type: type,
      status: newStatus,
      label,
      at: event.created_at,
      direction: direction || null,
      carrier: payload.carrier || null,
      tracking_code: payload.tracking_code || null,
      tracking_url: payload.tracking_url || null
    };
  });
}

async function customerShipmentView(shipment: JsonObject): Promise<JsonObject> {
  const photos = (Array.isArray(shipment.pickup_photo_urls) ? shipment.pickup_photo_urls : [])
    .map((value) => asString(value));
  const resolvedPhotos = await Promise.all(photos.map(resolveEvidenceRef));
  const video = shipment.package_video_url ? await resolveEvidenceRef(shipment.package_video_url) : "";
  return {
    shipment_id: shipment.shipment_id,
    return_item_id: shipment.return_item_id || null,
    direction: shipment.direction,
    order_id: shipment.order_id || null,
    carrier: shipment.carrier || null,
    tracking_code: shipment.tracking_code || null,
    tracking_url: shipment.tracking_url || null,
    label_url: shipment.label_url || null,
    handover_code: shipment.handover_code || null,
    status: shipment.status || null,
    picked_up_at: shipment.picked_up_at || null,
    delivered_at: shipment.delivered_at || null,
    pickup_photo_urls: resolvedPhotos.filter(Boolean),
    package_video_url: video || null
  };
}

async function customerReturnDetail(
  repository: UserReturnsRepository,
  ret: JsonObject,
  order: JsonObject | null,
  items: JsonObject[]
): Promise<JsonObject> {
  const [view, shipments, events, evidence, exchangeOrder] = await Promise.all([
    customerReturnView(repository, ret, order, items),
    repository.listReturnShipments ? repository.listReturnShipments(ret.return_id) : Promise.resolve([]),
    repository.listReturnEvents ? repository.listReturnEvents(ret.return_id) : Promise.resolve([]),
    listReturnEvidence(asString(ret.return_id)).catch(() => []),
    ret.exchange_order_id && repository.getExchangeOrder
      ? repository.getExchangeOrder(ret.exchange_order_id)
      : Promise.resolve(null)
  ]);
  const resolvedShipments = await Promise.all(shipments.map((row) => customerShipmentView(asJsonObject(row))));
  return {
    ...view,
    timeline: customerTimeline(events),
    shipments: resolvedShipments,
    shipment: resolvedShipments.find((row) => row.direction === "inbound") || null,
    exchange_shipment: resolvedShipments.find((row) => row.direction === "outbound") || null,
    evidence: evidence.filter((row) => CUSTOMER_VISIBLE_EVIDENCE_KINDS.includes(asString(row.kind))),
    exchange_order: exchangeOrder ? {
      order_id: exchangeOrder.order_id,
      order_code: exchangeOrder.order_code,
      status: exchangeOrder.status,
      carrier: exchangeOrder.carrier || null,
      tracking_code: exchangeOrder.tracking_code || null,
      tracking_url: exchangeOrder.tracking_url || null,
      order_kind: exchangeOrder.order_kind || "exchange",
      shipping_name: exchangeOrder.shipping_name || null,
      shipping_phone: exchangeOrder.shipping_phone || null,
      shipping_address: exchangeOrder.shipping_address || null,
      items: Array.isArray(exchangeOrder.items) ? exchangeOrder.items : []
    } : null,
    instructions: RETURN_INSTRUCTIONS
  };
}

/** Validates packing evidence timing and records a customer-visible custody event. */
async function addPackingEvidence(
  repository: UserReturnsRepository,
  ret: JsonObject,
  kind: string,
  note: string,
  actorId: string | null,
  req: HttpRequest
): Promise<JsonObject> {
  const status = asString(ret.status);
  const parts = await repository.listReturnItemsForReturn(ret.return_id);
  if (!(parts.length ? parts.some((part) => CUSTOMER_PACKING_STATUSES.includes(asString(part.item_status))) : CUSTOMER_PACKING_STATUSES.includes(status))) {
    throw new HttpError(422, "PACKING_EVIDENCE_CLOSED", "Chỉ có thể tải bằng chứng đóng gói trước khi ĐVVC lấy hàng.");
  }
  const evidence = await storeReturnEvidence({
    returnId: asString(ret.return_id),
    kind: kind as ReturnEvidenceKind,
    role: "customer",
    actorId,
    note: note || null,
    req
  });
  if (repository.insertReturnEvent) {
    await repository.insertReturnEvent({
      return_id: ret.return_id,
      old_status: status,
      new_status: status,
      actor_id: actorId,
      actor_type: "customer",
      event_type: "customer_evidence",
      payload: { kind, evidence_id: evidence.evidence_id || null },
      note: "Khách tải bằng chứng đóng gói"
    });
  }
  return { success: true, evidence };
}

/** Adds line/product detail once, for both the list and the detail endpoint. */
async function hydratedReturnItems(repository: UserReturnsRepository, returnId: unknown): Promise<JsonObject[]> {
  const items = await repository.listReturnItemsForReturn(returnId);
  const hydrated: JsonObject[] = [];
  for (const ri of items) {
    const exchange = ri.exchange_order_id && repository.getExchangeOrder ? await repository.getExchangeOrder(ri.exchange_order_id) : null;
    const orderItem = await repository.findOrderItem(ri.order_item_id);
    hydrated.push({
      item_status: ri.item_status,
      decision_status: ri.decision_status,
      resolution_type: ri.resolution_type,
      replacement_variant_id: ri.replacement_variant_id,
      exchange_order_id: ri.exchange_order_id,
      refund_amount: ri.refund_amount,
      attention_status: ri.attention_status,
      reason: ri.reason,
      created_at: ri.created_at,
      exchange_order: exchange ? {
        order_id: exchange.order_id,
        order_code: exchange.order_code,
        status: exchange.status,
        carrier: exchange.carrier || null,
        tracking_code: exchange.tracking_code || null,
        tracking_url: exchange.tracking_url || null
      } : null,
      updated_at: ri.updated_at,
      approved_at: ri.approved_at,
      rejected_at: ri.rejected_at,
      received_at: ri.received_at,
      completed_at: ri.completed_at,
      version: ri.version,
      return_item_id: ri.return_item_id,
      order_item_id: ri.order_item_id,
      quantity: ri.quantity,
      variant_id: orderItem ? orderItem.variant_id : null,
      product_name: orderItem ? orderItem.product_name : "Sản phẩm",
      product_image: orderItem ? orderItem.product_image : null,
      unit_price: orderItem ? orderItem.unit_price : 0
    });
  }
  return hydrated;
}

/** Validates the receiving account and stores it through the transactional RPC; returns the masked view. */
async function saveRefundReceiver(
  repository: UserReturnsRepository,
  ret: JsonObject,
  ownerUserId: string | null,
  body: JsonObject
): Promise<JsonObject> {
  const check = validateRefundReceiver(body);
  if (!check.ok) throw new HttpError(422, "REFUND_RECEIVER_INVALID", Object.values(check.errors)[0]?.[0] || "Thông tin nhận hoàn tiền chưa hợp lệ.", check.errors);
  const saved = await repository.setRefundReceiver(asString(ret.return_id), ownerUserId, check.value);
  return { success: true, refund_receiver: saved };
}

/** Danh mục phụ kiện, túi xách, giày dép... đều được phép đổi trả theo chính sách Velura. */
const RESTRICTED_CATEGORY_NAMES: readonly string[] = [];
const RESTRICTED_CATEGORY_SLUGS: readonly string[] = [];

/** U2-02: mỗi `order_item` chỉ được xử lý đổi/trả tối đa 2 lần, tính trên cả đơn, không phải trên toàn bộ lịch sử khách. */
const MAX_RETURN_ATTEMPTS_PER_ITEM = 2;

/** Replacement orders fulfil an exchange and cannot start a new return chain. */
async function rejectExchangeReplacementOrder(
  repository: UserReturnsRepository,
  orderId: unknown
): Promise<void> {
  if (repository.findReturnByExchangeOrderId && await repository.findReturnByExchangeOrderId(orderId)) {
    throw new HttpError(
      400,
      "EXCHANGE_REPLACEMENT_NOT_RETURNABLE",
      "Đơn hàng đổi mới không thể tạo thêm yêu cầu đổi/trả. Vui lòng theo dõi yêu cầu từ đơn hàng gốc."
    );
  }
}

function requireDeliveredWithinWindow(order: JsonObject): void {
  if (asString(order.status) !== "delivered") {
    throw new HttpError(400, "BAD_REQUEST", "Đơn hàng phải hoàn thành (giao thành công) mới được yêu cầu đổi trả");
  }
  const deliveryDate = new Date(asString(order.delivered_at));
  if (!returnWindowOpen(deliveryDate, new Date())) {
    throw new HttpError(400, "RETURN_WINDOW_CLOSED", "Quá thời hạn đổi/trả (7 ngày kể từ khi giao hàng)");
  }
}

/** COD receiving details are optional at intake, but any supplied destination must be valid. */
function refundBankPayload(order: JsonObject, _returnType: string, body: JsonObject): JsonObject {
  if (asString(order.payment_method).toUpperCase() !== "COD") return {};
  const bankName = asString(body.refund_bank_name).trim();
  const accountNumber = asString(body.refund_bank_account).trim();
  const accountHolder = asString(body.refund_bank_holder).trim();
  if (!bankName && !accountNumber && !accountHolder) return {};
  const checked = validateRefundReceiver({ bank_name: bankName, account_number: accountNumber, account_holder: accountHolder });
  if (!checked.ok) throw new HttpError(422, "REFUND_RECEIVER_INVALID", "Thông tin nhận hoàn tiền chưa hợp lệ.", checked.errors);
  return { refund_bank_name: checked.value.bankName, refund_bank_account: checked.value.accountNumber, refund_bank_holder: checked.value.accountHolder };
}

/**
 * Kiểm từng item khách chọn: thuộc đúng đơn, không thuộc danh mục hạn chế, chưa hết lượt
 * (U2-02) và chưa vượt số lượng đã mua (U2-12). Dùng chung cho cả member và guest vì hai
 * nhánh áp cùng rule trên cùng dữ liệu `order_item`/`return_item`.
 */
async function validateItemsAgainstOrder(
  repository: UserReturnsRepository,
  order: JsonObject,
  rawItems: unknown[],
  returnType: string
): Promise<JsonObject[]> {
  const validated: JsonObject[] = [];
  const seen = new Set<string>();

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
    let isCombo = false;
    if (variant) {
      const product = await repository.findProduct(variant.product_id);
      if (product) {
        isCombo = Boolean(product.is_combo || /combo/i.test(asString(product.name)) || /set\s+/i.test(asString(product.name)));
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
    if (!isCombo) {
      isCombo = /combo/i.test(asString(orderItem.product_name)) || /set\s+/i.test(asString(orderItem.product_name));
    }

    // Quy tắc Combo: Nếu là combo thì khi hoàn tiền phải hoàn đủ số lượng cả bộ combo
    if (isCombo && returnType === "refund" && Number(item.quantity) < Number(orderItem.quantity)) {
      throw new HttpError(
        400,
        "COMBO_FULL_RETURN_REQUIRED",
        `Sản phẩm Combo "${asString(orderItem.product_name)}" phải hoàn trả nguyên bộ, không tách lẻ số lượng hoàn tiền.`
      );
    }

    const units = await repository.listReturnUnits(item.order_item_id);
    const available = units.length
      ? units.filter((unit) => !unit.refunded && !unit.active_return_item_id && Number(unit.success_count) < MAX_RETURN_ATTEMPTS_PER_ITEM).length
      : Number(orderItem.quantity);
    if (Number(item.quantity) > available) {
      throw new HttpError(422, "RETURN_QUANTITY_EXCEEDED", "Số lượng vượt quá số lượng còn khả dụng đổi/trả.");
    }

    const replacementId = asString(item.replacement_variant_id);
    if (returnType === "exchange" && !replacementId) throw new HttpError(422, "REPLACEMENT_REQUIRED", "Vui lòng chọn variant cùng sản phẩm để đổi.");
    if (replacementId) {
      const replacement = await repository.findVariant(replacementId);
      if (!variant || !replacement || replacement.product_id !== variant.product_id) throw new HttpError(422,"EXCHANGE_SAME_PRODUCT_REQUIRED","Replacement must be a variant of the same product");
    }
    validated.push({ order_item_id: item.order_item_id, quantity: item.quantity,...(replacementId ? {replacement_variant_id:replacementId} : {}) });
  }

  return validated;
}

/** Rejects public URLs, inline blobs and absent initial proof before the atomic ownership claim. */
function intakeEvidence(body: JsonObject): { images: string[]; videos: string[]; description: string } {
  const description = [returnReasonLabel(asString(body.reason_code || body.reasonCode)), asString(body.description || body.reason || body.note).trim()].filter(Boolean).join(". ");
  if (!description) throw new HttpError(422, "RETURN_REASON_REQUIRED", "Vui lòng nhập lý do đổi/trả.");
  const refs = (value: unknown): string[] => Array.isArray(value) ? value.filter((ref): ref is string => typeof ref === "string") : [];
  const images = refs(body.evidence_images);
  const videos = refs(body.evidence_videos);
  if (!images.length || !videos.length || images.length > 5 || videos.length > 3) throw new HttpError(422, "INITIAL_EVIDENCE_REQUIRED", "Cần ít nhất một ảnh và một video ban đầu (tối đa 5 ảnh, 3 video).");
  if ([...images, ...videos].some((ref) => !ref.startsWith("storage://return-evidence-private/return-intake/")) || new Set([...images, ...videos]).size !== images.length + videos.length) {
    throw new HttpError(422, "INVALID_RETURN_EVIDENCE", "Bằng chứng phải được tải riêng cho đơn hàng này.");
  }
  return { images, videos, description };
}

/** Member and verified guest intake share every policy and the same all-or-nothing database write. */
async function createForOrder(repository: UserReturnsRepository, order: JsonObject, body: JsonObject): Promise<JsonObject> {
  if (order.order_kind === "exchange") throw new HttpError(400, "EXCHANGE_REPLACEMENT_NOT_RETURNABLE", "Vui lòng tạo yêu cầu từ đơn hàng gốc.");
  await rejectExchangeReplacementOrder(repository, order.order_id);
  requireDeliveredWithinWindow(order);
  const returnType = asString(body.return_type);
  if (!["refund", "exchange"].includes(returnType)) throw new HttpError(422, "INVALID_RETURN_TYPE", "Choose refund or exchange");
  if (!Array.isArray(body.items) || !body.items.length) throw new HttpError(422, "INVALID_RETURN_ITEMS", "Vui lòng chọn sản phẩm.");
  const evidence = intakeEvidence(body);
  const items = await validateItemsAgainstOrder(repository, order, body.items, returnType);
  const bank = refundBankPayload(order, returnType, body);
  const created = await repository.createReturnBundle({
    order_id: order.order_id, user_id: order.user_id || null, return_type: returnType,
    reason: evidence.description, description: evidence.description,
    evidence_images: evidence.images, evidence_videos: evidence.videos,
    ...bank
  }, items);
  return customerReturnView(repository, created, order, await hydratedReturnItems(repository, created.return_id));
}

/**
 * Create/list/cancel use-cases consumed by `handleReturnsRoute`.
 */
export function createUserReturnsService(repository: UserReturnsRepository) {
  return {
    /** Creates a return only for the authenticated purchaser's delivered order. */
    async createForMember(profile: UserProfile, body: JsonObject) {
      const order = await repository.findOrderById(asString(body.order_id));
      if (!order || order.user_id !== profile.user_id) throw new HttpError(403, "FORBIDDEN", "Đơn hàng không hợp lệ");
      return createForOrder(repository, order, body);
    },

    /** A signed same-phone guest session authorizes the same atomic intake as members. */
    async createForGuest(body: JsonObject) {
      const code = asString(body.order_code).trim().toUpperCase();
      let order = await repository.findOrderByCode(code);
      if (!order && /^[0-9a-f-]{36}$/i.test(code)) order = await repository.findOrderById(code);
      if (!order || !hasGuestOrderAccess(order, body)) throw new HttpError(404, "NOT_FOUND", "Order not found");
      return createForOrder(repository, order, body);
    },

    /** Lists return requests only after a signed same-phone session authorizes the order. */
    async listForGuest(body: JsonObject) {
      const order = await repository.findOrderById(asString(body.order_id));
      if (!order || !hasGuestOrderAccess(order, body)) throw new HttpError(404,"NOT_FOUND","Order not found");
      const rows = await repository.listReturnsForOrder(order.order_id);
      const populated: JsonObject[] = [];
      for (const ret of rows) populated.push(await customerReturnView(repository, ret, order, await hydratedReturnItems(repository, ret.return_id)));
      return populated;
    },
    /** Cancels only a request bound to the verified order and its current version. */
    async cancelForGuest(body: JsonObject) {
      const ret = await repository.findReturnById(body.return_id);
      const order = ret ? await repository.findOrderById(asString(ret.order_id)) : null;
      if (!ret || !order || !hasGuestOrderAccess(order, body)) throw new HttpError(404,"NOT_FOUND","Order not found");
      const version = Number(body.expectedVersion);
      if (!Number.isInteger(version) || version !== Number(ret.version)) throw new HttpError(409,"VERSION_CONFLICT","Yêu cầu đổi/trả đã thay đổi, vui lòng tải lại");
      if (!CUSTOMER_CANCELLABLE_STATUSES.includes(asString(ret.status))) throw new HttpError(422,"INVALID_TRANSITION","Yêu cầu đã chuyển sang bước xử lý hàng nên không thể tự hủy");
      return repository.cancelReturn(ret.return_id, version, null);
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
      if (!CUSTOMER_CANCELLABLE_STATUSES.includes(asString(ret.status))) {
        throw new HttpError(
          400,
          "BAD_REQUEST",
          "Chỉ có thể hủy yêu cầu khi chưa gửi hàng (đang Chờ xử lý, CSKH đang liên hệ hoặc Chờ gửi hàng)"
        );
      }
      if (asNumber(ret.version) !== expectedVersion) {
        throw new HttpError(409, "VERSION_CONFLICT", "Yêu cầu đổi/trả đã thay đổi, vui lòng tải lại");
      }
      return repository.cancelReturn(returnId, expectedVersion, profile.user_id);
    },

    /**
     * Member saves the COD receiving account for their own refund request. The database re-validates and refuses
     * requests that are closed or not COD refunds.
     */
    async saveRefundReceiverForMember(profile: UserProfile, body: JsonObject) {
      const ret = await repository.findReturnById(body.return_id);
      if (!ret || ret.user_id !== profile.user_id) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy yêu cầu đổi trả");
      return saveRefundReceiver(repository, ret, profile.user_id, body);
    },

    /** Verified guest saves the COD receiving account; the signed session must authorize the request's order. */
    async saveRefundReceiverForGuest(body: JsonObject) {
      const ret = await repository.findReturnById(body.return_id);
      const order = ret ? await repository.findOrderById(asString(ret.order_id)) : null;
      if (!ret || !order || !hasGuestOrderAccess(order, body)) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy yêu cầu đổi trả");
      return saveRefundReceiver(repository, ret, null, body);
    },

    async listForMember(profile: UserProfile, orderId: string | null) {
      const returns = await repository.listReturnsForUser(profile.user_id, orderId || undefined);
      const populated: JsonObject[] = [];
      for (const ret of returns) {
        const order = await repository.findOrderById(asString(ret.order_id));
        populated.push(await customerReturnView(
          repository,
          ret,
          order,
          await hydratedReturnItems(repository, ret.return_id)
        ));
      }
      populated.sort((a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime());
      return populated;
    },

    /** One return with shipment, evidence, timeline and linked replacement order. */
    async detailForMember(profile: UserProfile, returnId: string) {
      const ret = await repository.findReturnById(returnId);
      if (!ret || ret.user_id !== profile.user_id) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy yêu cầu đổi trả");
      return customerReturnDetail(
        repository,
        ret,
        await repository.findOrderById(asString(ret.order_id)),
        await hydratedReturnItems(repository, ret.return_id)
      );
    },

    /** Guest detail is gated by the signed order-access proof, never by return_id alone. */
    async detailForGuest(returnId: string, guestAccessToken: string) {
      const ret = await repository.findReturnById(returnId);
      const order = ret ? await repository.findOrderById(asString(ret.order_id)) : null;
      if (!ret || !order || !hasGuestOrderAccess(order, { guest_access_token: guestAccessToken })) {
        throw new HttpError(404, "NOT_FOUND", "Không tìm thấy yêu cầu đổi trả");
      }
      return customerReturnDetail(
        repository,
        ret,
        order,
        await hydratedReturnItems(repository, ret.return_id)
      );
    },

    /** Member uploads packing photos/video before the carrier takes the parcel. */
    async addPackingEvidenceForMember(profile: UserProfile, returnId: string, kind: string, note: string, req: HttpRequest) {
      const ret = await repository.findReturnById(returnId);
      if (!ret || ret.user_id !== profile.user_id) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy yêu cầu đổi trả");
      return addPackingEvidence(repository, ret, kind, note, profile.user_id, req);
    },

    /** Verified guest uploads packing evidence for an order they proved access to. */
    async addPackingEvidenceForGuest(returnId: string, kind: string, note: string, guestAccessToken: string, req: HttpRequest) {
      const ret = await repository.findReturnById(returnId);
      const order = ret ? await repository.findOrderById(asString(ret.order_id)) : null;
      if (!ret || !order || !hasGuestOrderAccess(order, { guest_access_token: guestAccessToken })) {
        throw new HttpError(404, "NOT_FOUND", "Không tìm thấy yêu cầu đổi trả");
      }
      return addPackingEvidence(repository, ret, kind, note, null, req);
    }
  };
}

export type UserReturnsService = ReturnType<typeof createUserReturnsService>;
