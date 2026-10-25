/**
 * Mã QR dùng chung cho đơn hàng, vận đơn và phiếu đổi trả.
 *
 * Một mã do hệ thống tạo ra phải đọc được bằng camera điện thoại (link https mở thẳng
 * workspace) và bằng chính ERP (scheme nội bộ mang thêm dữ liệu). Bộ phân tích ở đây là
 * nguồn duy nhất cho cả hai phía, nên thêm trường mới không phải sửa từng màn hình.
 */

/** Scheme nội bộ của một vận đơn: mang đủ ĐVVC, mã vận đơn và URL tracking. */
export const SHIPMENT_QR_SCHEME = "velura:shipment:1";
/** Scheme nội bộ của một đơn: id + mã đơn để đối chiếu khi quét. */
export const ORDER_QR_SCHEME = "velura:order:1";
/** Scheme nội bộ của một phiếu đổi trả. */
export const RETURN_QR_SCHEME = "velura:return:1";

/** Dữ liệu một vận đơn có thể điền từ một lần quét. */
export interface ShipmentQrFacts {
  readonly orderCode?: string;
  readonly carrier?: string;
  readonly trackingCode?: string;
  readonly trackingUrl?: string;
}

export type ScanKind = "shipment" | "order" | "return" | "tracking" | "unknown";

/** Kết quả phân tích một chuỗi QR, kèm lý do nếu mã thuộc đơn khác. */
export interface ScanResult {
  readonly kind: ScanKind;
  readonly raw: string;
  readonly orderCode?: string;
  readonly orderId?: string;
  readonly returnId?: string;
  readonly carrier?: string;
  readonly trackingCode?: string;
  readonly trackingUrl?: string;
  /** `ORDER_MISMATCH` khi mã quét được thuộc một đơn khác đơn đang mở. */
  readonly mismatch?: string | null;
}

/** ĐVVC phổ biến + trang tracking công khai; template chỉ dùng khi biết chắc tham số. */
export interface CarrierProfile {
  readonly code: string;
  readonly label: string;
  readonly homepage: string;
  readonly trackingTemplate?: string;
}

export const CARRIER_PROFILES: readonly CarrierProfile[] = [
  { code: "GHN", label: "GHN", homepage: "https://ghn.vn/", trackingTemplate: "https://donhang.ghn.vn/?order_code={code}" },
  { code: "GHTK", label: "Giao Hàng Tiết Kiệm", homepage: "https://ghtk.vn/", trackingTemplate: "https://i.ghtk.vn/{code}" },
  { code: "VIETTELPOST", label: "Viettel Post", homepage: "https://viettelpost.com.vn/" },
  { code: "VNPOST", label: "VNPost", homepage: "https://www.vnpost.vn/" },
  { code: "JTX", label: "J&T Express", homepage: "https://jtexpress.vn/" },
  { code: "SPX", label: "Shopee Express", homepage: "https://spx.vn/" },
  { code: "NINJAVAN", label: "Ninja Van", homepage: "https://www.ninjavan.co/vi-vn" },
  { code: "BEST", label: "Best Express", homepage: "https://bestexpress.vn/" },
];

/** Mã vận đơn thường chỉ là chữ/số; chặn chuỗi rỗng hoặc câu văn. */
const TRACKING_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{4,59}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tạo payload QR cho một vận đơn. Giá trị được URL-encode nên tên ĐVVC có dấu cách
 * hoặc URL tracking dài vẫn đọc lại đúng.
 */
export function buildShipmentQr(facts: ShipmentQrFacts): string {
  const params = new URLSearchParams();
  if (facts.orderCode) params.set("order", facts.orderCode.trim());
  if (facts.carrier) params.set("carrier", facts.carrier.trim());
  if (facts.trackingCode) params.set("tracking", facts.trackingCode.trim());
  if (facts.trackingUrl) params.set("url", facts.trackingUrl.trim());
  return `${SHIPMENT_QR_SCHEME}?${params.toString()}`;
}

/**
 * Link mở thẳng đơn trên ERP (payload tốt nhất cho camera điện thoại thông thường).
 */
export function buildOrderQrLink(origin: string, orderId: string, orderCode?: string | null): string {
  const url = new URL("/orders", origin);
  url.searchParams.set("focus", orderId);
  if (orderCode) url.searchParams.set("code", orderCode);
  return url.toString();
}

/** Link mở thẳng phiếu đổi trả trên ERP. */
export function buildReturnQrLink(origin: string, returnId: string): string {
  const url = new URL("/returns", origin);
  url.searchParams.set("focus", returnId);
  return url.toString();
}

/**
 * Phân tích một chuỗi QR theo thứ tự: scheme nội bộ → JSON → link ERP → mã vận đơn thuần.
 * `options.orderId/orderCode` là đơn đang mở; nếu mã thuộc đơn khác thì trả `mismatch`.
 */
export function parseScan(
  text: string,
  options: { origin?: string; orderId?: string | null; orderCode?: string | null } = {},
): ScanResult {
  const raw = String(text || "").trim();
  if (!raw) return { kind: "unknown", raw };

  const scheme = schemeResult(raw);
  if (scheme) return withMismatch(scheme, options);

  const json = jsonResult(raw);
  if (json) return withMismatch(json, options);

  const link = linkResult(raw, options.origin);
  if (link) return withMismatch(link, options);

  if (TRACKING_PATTERN.test(raw)) {
    return { kind: "tracking", raw, trackingCode: raw };
  }
  return { kind: "unknown", raw };
}

function schemeResult(raw: string): ScanResult | null {
  if (raw.startsWith(`${SHIPMENT_QR_SCHEME}?`)) {
    const params = new URLSearchParams(raw.slice(SHIPMENT_QR_SCHEME.length + 1));
    return {
      kind: "shipment",
      raw,
      orderCode: params.get("order") || undefined,
      carrier: params.get("carrier") || undefined,
      trackingCode: params.get("tracking") || undefined,
      trackingUrl: params.get("url") || undefined,
    };
  }
  if (raw.startsWith(`${ORDER_QR_SCHEME}?`)) {
    const params = new URLSearchParams(raw.slice(ORDER_QR_SCHEME.length + 1));
    return { kind: "order", raw, orderId: params.get("id") || undefined, orderCode: params.get("code") || undefined };
  }
  if (raw.startsWith(`${RETURN_QR_SCHEME}?`)) {
    const params = new URLSearchParams(raw.slice(RETURN_QR_SCHEME.length + 1));
    return { kind: "return", raw, returnId: params.get("id") || undefined };
  }
  return null;
}

function jsonResult(raw: string): ScanResult | null {
  if (!raw.startsWith("{")) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const kind = String(row["kind"] || "");
  const text = (key: string): string | undefined => (typeof row[key] === "string" ? (row[key] as string) : undefined);
  if (kind === "shipment") {
    return {
      kind: "shipment",
      raw,
      orderCode: text("orderCode") || text("order"),
      carrier: text("carrier"),
      trackingCode: text("trackingCode") || text("tracking"),
      trackingUrl: text("trackingUrl") || text("url"),
    };
  }
  if (kind === "order") {
    return { kind: "order", raw, orderId: text("orderId") || text("id"), orderCode: text("orderCode") || text("code") };
  }
  if (kind === "return") {
    return { kind: "return", raw, returnId: text("returnId") || text("id") };
  }
  return null;
}

function linkResult(raw: string, origin: string | undefined): ScanResult | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const focus = url.searchParams.get("focus") || "";
  const code = url.searchParams.get("code") || "";
  const path = url.pathname.replace(/\/+$/, "");
  if (!origin || origin === url.origin) {
    if (path.endsWith("/orders")) {
      return { kind: "order", raw, orderId: UUID_PATTERN.test(focus) ? focus : undefined, orderCode: code || undefined };
    }
    if (path.endsWith("/returns")) {
      return { kind: "return", raw, returnId: UUID_PATTERN.test(focus) ? focus : undefined };
    }
  }
  return null;
}

function withMismatch(
  result: ScanResult,
  options: { orderId?: string | null; orderCode?: string | null },
): ScanResult {
  const expectedCode = normalizeOrderCode(options.orderCode);
  const scannedCode = normalizeOrderCode(result.orderCode);
  if (options.orderId && result.orderId && result.orderId !== options.orderId) {
    return { ...result, mismatch: "ORDER_MISMATCH" };
  }
  if (expectedCode && scannedCode && expectedCode !== scannedCode) {
    return { ...result, mismatch: "ORDER_MISMATCH" };
  }
  return result;
}

function normalizeOrderCode(value: string | null | undefined): string {
  return String(value || "").trim().toUpperCase();
}

/** Tên ĐVVC đã biết theo mã hoặc nhãn (không phân biệt hoa thường). */
export function findCarrier(input: string | null | undefined): CarrierProfile | undefined {
  const needle = String(input || "").trim().toLowerCase();
  if (!needle) return undefined;
  return CARRIER_PROFILES.find(
    (profile) => profile.code.toLowerCase() === needle || profile.label.toLowerCase() === needle,
  );
}

/**
 * URL tracking suy ra từ ĐVVC + mã vận đơn: dùng template khi có, nếu không thì trang chủ
 * của ĐVVC. Trả chuỗi rỗng khi không nhận ra ĐVVC để ô URL giữ nguyên giá trị người dùng nhập.
 */
export function deriveTrackingUrl(carrier: string | null | undefined, trackingCode: string | null | undefined): string {
  const profile = findCarrier(carrier);
  if (!profile) return "";
  const code = String(trackingCode || "").trim();
  if (profile.trackingTemplate && code) {
    return profile.trackingTemplate.replace("{code}", encodeURIComponent(code));
  }
  return profile.homepage;
}

/** Tên hiển thị của ĐVVC: nhãn đã biết, hoặc giá trị người dùng nhập. */
export function carrierLabel(input: string | null | undefined): string {
  const profile = findCarrier(input);
  return profile ? profile.label : String(input || "").trim();
}
