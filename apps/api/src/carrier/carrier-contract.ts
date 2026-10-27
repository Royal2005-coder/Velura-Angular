import { createHmac, timingSafeEqual } from "node:crypto";
import { asJsonObject, asString, type JsonObject } from "../types.js";

/**
 * Hợp đồng webhook vận tải của Velura (KAN-106).
 *
 * Hệ thống cố ý KHÔNG giả định schema riêng của GHN/GHTK/VTP. Mỗi nhà vận chuyển được một lớp
 * trung gian (gateway/n8n, hoặc chính tool mô phỏng của đội vận hành) dịch sang đúng hình dạng
 * này rồi ký HMAC bằng cùng một bí mật. Nhờ vậy hành vi luồng đơn trong production là một đường
 * duy nhất, và mã trạng thái lạ không bao giờ âm thầm đi vào state machine.
 */

/** Trạng thái vận chuyển mà Velura chấp nhận; mỗi giá trị ứng với MỘT action system có sẵn. */
export const CARRIER_EVENT_STATUSES = ["delivered", "failed_retrying", "failed_returned"] as const;
export type CarrierEventStatus = (typeof CARRIER_EVENT_STATUSES)[number];

/**
 * Action system mà API sẽ chạy cho từng trạng thái. Đây là ba mã `actor: "system"` duy nhất mà
 * `ORDER_ACTIONS` cho phép đơn đang `shipping` nhận; webhook không được quyền tạo trạng thái mới.
 */
export const CARRIER_STATUS_ACTIONS: Readonly<Record<CarrierEventStatus, string>> = {
  delivered: "carrier_delivered",
  failed_retrying: "carrier_failed_retrying",
  failed_returned: "carrier_failed_returned",
};

/** Tên một nhà vận chuyển trong path: token ngắn, chữ thường, không có khoảng trắng. */
export const CARRIER_PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]{1,23}$/;
/** Mã sự kiện phía nhà vận chuyển gửi tới; dùng làm khoá chống lặp. */
export const CARRIER_EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{4,120}$/;
/** Vận đơn chỉ gồm ký tự an toàn cho URL và cho việc đối chiếu thủ công. */
export const CARRIER_TRACKING_PATTERN = /^[A-Za-z0-9-]{6,60}$/;
/** Mã phiếu hoàn nội bộ, dùng làm fallback khi nhà vận chuyển có gửi kèm. */
export const CARRIER_RETURN_CODE_PATTERN = /^[A-Za-z0-9-]{4,40}$/;

/** Body webhook tối đa: một sự kiện vận tải nhỏ, không cần dung lượng như đơn hàng. */
export const MAX_CARRIER_BODY_BYTES = 64 * 1024;
/** Chữ ký chỉ có giá trị trong 5 phút, chặn phát lại từ bản capture cũ. */
export const CARRIER_SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;
/** Sự kiện quá 30 ngày là dữ liệu tồn kho của nhà vận chuyển, không còn là tín hiệu vận hành. */
export const CARRIER_EVENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Chi tiết/ly do dài tối đa; phần thừa bị cắt, không âm thầm mất bằng chứng. */
export const MAX_CARRIER_DETAIL_LENGTH = 500;

/** Một sự kiện vận tải đã được kiểm tra hình dạng, sẵn sàng cho state machine. */
export interface CarrierDeliveryEvent {
  readonly provider: string;
  readonly providerEventId: string;
  /** Có thể rỗng khi ĐVVC chỉ gửi AWB; service sẽ match return shipment theo AWB. */
  readonly orderCode: string;
  readonly returnCode?: string;
  readonly trackingCode: string;
  readonly status: CarrierEventStatus;
  readonly occurredAt: string;
  readonly detail: string;
  /** Người vận hành đứng sau một push được mô phỏng; đi vào dấu vết để không mất ai-là-ai. */
  readonly operatorId?: string;
  readonly raw: JsonObject;
}

export type CarrierEventResult =
  | { readonly ok: true; readonly event: CarrierDeliveryEvent }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Mã lỗi nghiệp vụ của webhook, kèm câu tiếng Việt để route không phải tự viết string.
 */
export const CARRIER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  CARRIER_PROVIDER_UNSUPPORTED: "Nhà vận chuyển không hợp lệ.",
  CARRIER_SIGNATURE_MISSING: "Thiếu chữ ký webhook ở header x-carrier-signature.",
  CARRIER_SIGNATURE_INVALID: "Chữ ký webhook không hợp lệ hoặc đã hết hạn.",
  CARRIER_WEBHOOK_NOT_CONFIGURED: "Chưa cấu hình CARRIER_WEBHOOK_SECRET.",
  CARRIER_EVENT_REQUIRED: "Body webhook phải là một đối tượng JSON.",
  CARRIER_EVENT_ID_REQUIRED: "Thiếu mã sự kiện vận tải (providerEventId).",
  CARRIER_ORDER_CODE_REQUIRED: "Mã đơn hàng không hợp lệ (orderCode).",
  CARRIER_RETURN_CODE_INVALID: "Mã phiếu hoàn không hợp lệ (returnCode).",
  CARRIER_TRACKING_REQUIRED: "Mã vận đơn không hợp lệ (trackingCode).",
  CARRIER_STATUS_UNSUPPORTED: "Trạng thái vận chuyển không thuộc danh sách Velura cho phép.",
  CARRIER_OCCURRED_AT_REQUIRED: "Thời gian xảy ra sự kiện không hợp lệ (occurredAt).",
  CARRIER_EVENT_TOO_OLD: "Sự kiện vận tải quá cũ, không cập nhật đơn nữa.",
  CARRIER_EVENT_FROM_FUTURE: "Sự kiện vận tải có thời gian ở tương lai.",
  CARRIER_BODY_TOO_LARGE: "Body webhook vượt quá giới hạn cho phép.",
  CARRIER_ORDER_NOT_FOUND: "Không tìm thấy đơn hàng/phiếu hoàn theo dữ liệu nhà vận chuyển gửi tới.",
  CARRIER_TRACKING_MISMATCH: "Mã vận đơn trong sự kiện không khớp vận đơn đã bàn giao của đơn này.",
  CARRIER_RETURN_TRACKING_MISMATCH: "Mã vận đơn không khớp vận đơn hoàn đã tạo cho phiếu này.",
  CARRIER_RETURN_CODE_MISMATCH: "Mã phiếu hoàn không khớp vận đơn hoàn tìm thấy theo AWB.",
  CARRIER_RETURN_AMBIGUOUS: "Có nhiều vận đơn hoàn cùng mã; cần gửi kèm returnCode để phân biệt.",
  CARRIER_TRACKING_AMBIGUOUS: "Có nhiều đơn hàng cùng mã vận đơn; cần gửi kèm orderCode.",
  CARRIER_EVENT_NOT_RECORDED: "Không ghi được sự kiện vận tải."
};

/**
 * Câu báo tiếng Việt cho một mã lỗi webhook.
 */
export function carrierErrorMessage(code: string): string {
  return CARRIER_ERROR_MESSAGES[code] || "Không xử lý được webhook vận tải.";
}

/**
 * Kiểm tra chữ ký `t=<epoch>,v1=<hex>` trên đúng raw body đã nhận.
 *
 * Cùng khuôn với chữ ký Stripe trong `payments/stripe.ts`: HMAC-SHA256 trên `${t}.${rawBody}`,
 * từ chối tem quá 5 phút và so sánh bằng `timingSafeEqual` để không rò rỉ qua thời gian so sánh.
 */
export function verifyCarrierSignature(rawBody: string, header: string, secret: string, nowMs = Date.now()): boolean {
  if (!secret || !header) return false;
  const parts = header.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2) || "";
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0) return false;
  const stamp = Number(timestamp) * 1000;
  if (!Number.isFinite(stamp) || Math.abs(nowMs - stamp) > CARRIER_SIGNATURE_MAX_SKEW_MS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"));
  return signatures.some((signature) => {
    if (!/^[0-9a-f]*$/i.test(signature)) return false;
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

/**
 * Dựng chuỗi ký webhook cho đúng raw body, dùng bởi tool mô phỏng và bởi test.
 */
export function buildCarrierSignature(rawBody: string, secret: string, nowMs = Date.now()): string {
  const timestamp = Math.floor(nowMs / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

function text(value: unknown): string {
  return asString(value).trim();
}

/**
 * Thử một body JSON đã ký thành sự kiện vận tải hợp lệ.
 *
 * Mọi trường bắt buộc đều phải có; không suy đoán trạng thái từ tự do tiếng Việt, vì một từ khoá
 * bị đọc sai sẽ đẩy đơn sang trạng thái cuối không thể quay lại.
 */
export function normalizeCarrierEvent(provider: string, body: unknown): CarrierEventResult {
  if (!CARRIER_PROVIDER_PATTERN.test(provider)) {
    return { ok: false, code: "CARRIER_PROVIDER_UNSUPPORTED", message: carrierErrorMessage("CARRIER_PROVIDER_UNSUPPORTED") };
  }
  const payload = asJsonObject(body);
  if (Object.keys(payload).length === 0) {
    return { ok: false, code: "CARRIER_EVENT_REQUIRED", message: carrierErrorMessage("CARRIER_EVENT_REQUIRED") };
  }
  const providerEventId = text(payload.providerEventId);
  if (!CARRIER_EVENT_ID_PATTERN.test(providerEventId)) {
    return { ok: false, code: "CARRIER_EVENT_ID_REQUIRED", message: carrierErrorMessage("CARRIER_EVENT_ID_REQUIRED") };
  }
  const orderCode = text(payload.orderCode);
  if (orderCode.length > 40) {
    return { ok: false, code: "CARRIER_ORDER_CODE_REQUIRED", message: carrierErrorMessage("CARRIER_ORDER_CODE_REQUIRED") };
  }
  const returnCode = text(payload.returnCode);
  if (returnCode && !CARRIER_RETURN_CODE_PATTERN.test(returnCode)) {
    return { ok: false, code: "CARRIER_RETURN_CODE_INVALID", message: carrierErrorMessage("CARRIER_RETURN_CODE_INVALID") };
  }
  const trackingCode = text(payload.trackingCode);
  if (!CARRIER_TRACKING_PATTERN.test(trackingCode)) {
    return { ok: false, code: "CARRIER_TRACKING_REQUIRED", message: carrierErrorMessage("CARRIER_TRACKING_REQUIRED") };
  }
  const status = text(payload.status) as CarrierEventStatus;
  if (!CARRIER_EVENT_STATUSES.includes(status)) {
    return { ok: false, code: "CARRIER_STATUS_UNSUPPORTED", message: carrierErrorMessage("CARRIER_STATUS_UNSUPPORTED") };
  }
  const occurredAt = text(payload.occurredAt);
  const occurredMs = Date.parse(occurredAt);
  if (Number.isNaN(occurredMs)) {
    return { ok: false, code: "CARRIER_OCCURRED_AT_REQUIRED", message: carrierErrorMessage("CARRIER_OCCURRED_AT_REQUIRED") };
  }
  const nowMs = Date.now();
  if (occurredMs > nowMs + 60 * 60 * 1000) {
    return { ok: false, code: "CARRIER_EVENT_FROM_FUTURE", message: carrierErrorMessage("CARRIER_EVENT_FROM_FUTURE") };
  }
  if (nowMs - occurredMs > CARRIER_EVENT_MAX_AGE_MS) {
    return { ok: false, code: "CARRIER_EVENT_TOO_OLD", message: carrierErrorMessage("CARRIER_EVENT_TOO_OLD") };
  }
  return {
    ok: true,
    event: {
      provider,
      providerEventId,
      orderCode,
      returnCode: returnCode || undefined,
      trackingCode,
      status,
      occurredAt: new Date(occurredMs).toISOString(),
      detail: text(payload.detail).slice(0, MAX_CARRIER_DETAIL_LENGTH),
      raw: payload,
    },
  };
}

/**
 * Dòng ghi chú đi vào dấu vết đơn hàng: ai báo gì, lúc nào, kèm lý do nếu nhà vận chuyển gửi.
 */
export function carrierEventNote(event: CarrierDeliveryEvent): string {
  const when = event.occurredAt.slice(0, 16).replace("T", " ");
  const ref = event.returnCode
    ? `phiếu hoàn ${event.returnCode}`
    : event.orderCode
      ? `đơn ${event.orderCode}`
      : `vận đơn ${event.trackingCode}`;
  const head = `${event.provider} báo ${event.status} (${ref}, vận đơn ${event.trackingCode}, lúc ${when})`;
  return event.detail ? `${head}: ${event.detail}` : head;
}

/**
 * Payload lưu cùng order_event để admin đọc lại đúng bằng chứng gốc, không phải chuỗi đã cắt.
 */
export function carrierEventPayload(event: CarrierDeliveryEvent): JsonObject {
  return {
    provider: event.provider,
    provider_event_id: event.providerEventId,
    provider_status: event.status,
    order_code: event.orderCode || null,
    return_code: event.returnCode || null,
    tracking_code: event.trackingCode,
    occurred_at: event.occurredAt,
    ...(event.operatorId ? { operator_id: event.operatorId } : {}),
  };
}
