import { CARRIER_TRACKING_PATTERN } from "./carrier-contract.js";

/** Scheme QR của vận đơn; phải khớp `SHIPMENT_QR_SCHEME` mà ERP đọc khi quét. */
export const SHIPMENT_LABEL_QR_SCHEME = "velura:shipment:1";

/** Đơn vị vận chuyển mà bộ mô phỏng phát hành vận đơn. */
const SIMULATED_CARRIER = "GHN";
const SIMULATED_TRACKING_URL = "https://donhang.ghn.vn/?order_code=";

/** Phần của đơn mà bộ mô phỏng cần để phát hành vận đơn. */
export interface WaybillOrder {
  readonly order_id?: unknown;
  readonly order_code?: unknown;
}

/** Vận đơn do cổng ĐVVC mô phỏng phát hành, kèm payload QR in trên nhãn. */
export interface SimulatedWaybill {
  readonly carrier: string;
  readonly trackingCode: string;
  readonly trackingUrl: string;
  /** Payload `velura:shipment:1?...` mà màn "Xác nhận vận đơn" quét để điền ĐVVC và mã vận đơn. */
  readonly labelQr: string;
}

/**
 * Phát hành vận đơn mô phỏng cho một đơn (cổng ĐVVC thật chưa nối).
 *
 * Kết quả xác định theo mã đơn: gọi lại cho cùng một đơn luôn ra cùng mã vận đơn, nên nhãn đã
 * in vẫn khớp khi mở lại đơn. Hàm không ghi gì vào đơn — vận đơn chỉ được lưu khi admin quét
 * nhãn ở bước "Xác nhận vận đơn".
 */
export function createWaybill(order: WaybillOrder): SimulatedWaybill {
  const orderCode = String(order.order_code ?? "").trim();
  const seed = `${orderCode}`.replace(/[^A-Za-z0-9]/g, "").toUpperCase() ||
    String(order.order_id ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const tail = (seed.length >= 3 ? seed : `${seed}000`).slice(-9);
  const trackingCode = `${SIMULATED_CARRIER}${tail}`;
  if (!CARRIER_TRACKING_PATTERN.test(trackingCode)) {
    throw new TypeError("Không tạo được mã vận đơn hợp lệ cho đơn này.");
  }
  const trackingUrl = `${SIMULATED_TRACKING_URL}${encodeURIComponent(trackingCode)}`;
  const params = new URLSearchParams();
  if (orderCode) params.set("order", orderCode);
  params.set("carrier", SIMULATED_CARRIER);
  params.set("tracking", trackingCode);
  params.set("url", trackingUrl);
  return {
    carrier: SIMULATED_CARRIER,
    trackingCode,
    trackingUrl,
    labelQr: `${SHIPMENT_LABEL_QR_SCHEME}?${params.toString()}`
  };
}
import { CARRIER_TRACKING_PATTERN } from "./carrier-contract.js";

/** Scheme QR của vận đơn; phải khớp `SHIPMENT_QR_SCHEME` mà ERP đọc khi quét. */
export const SHIPMENT_LABEL_QR_SCHEME = "velura:shipment:1";

/** Đơn vị vận chuyển mà bộ mô phỏng phát hành vận đơn. */
const SIMULATED_CARRIER = "GHN";
const SIMULATED_TRACKING_URL = "https://donhang.ghn.vn/?order_code=";

/** Phần của đơn mà bộ mô phỏng cần để phát hành vận đơn. */
export interface WaybillOrder {
  readonly order_id?: unknown;
  readonly order_code?: unknown;
}

/** Vận đơn do cổng ĐVVC mô phỏng phát hành, kèm payload QR in trên nhãn. */
export interface SimulatedWaybill {
  readonly carrier: string;
  readonly trackingCode: string;
  readonly trackingUrl: string;
  /** Payload `velura:shipment:1?...` mà màn "Xác nhận vận đơn" quét để điền ĐVVC và mã vận đơn. */
  readonly labelQr: string;
}

/**
 * Phát hành vận đơn mô phỏng cho một đơn (cổng ĐVVC thật chưa nối).
 *
 * Kết quả xác định theo mã đơn: gọi lại cho cùng một đơn luôn ra cùng mã vận đơn, nên nhãn đã
 * in vẫn khớp khi mở lại đơn. Hàm không ghi gì vào đơn — vận đơn chỉ được lưu khi admin quét
 * nhãn ở bước "Xác nhận vận đơn".
 */
export function createWaybill(order: WaybillOrder): SimulatedWaybill {
  const orderCode = String(order.order_code ?? "").trim();
  const seed = `${orderCode}`.replace(/[^A-Za-z0-9]/g, "").toUpperCase() ||
    String(order.order_id ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const tail = (seed.length >= 3 ? seed : `${seed}000`).slice(-9);
  const trackingCode = `${SIMULATED_CARRIER}${tail}`;
  if (!CARRIER_TRACKING_PATTERN.test(trackingCode)) {
    throw new TypeError("Không tạo được mã vận đơn hợp lệ cho đơn này.");
  }
  const trackingUrl = `${SIMULATED_TRACKING_URL}${encodeURIComponent(trackingCode)}`;
  const params = new URLSearchParams();
  if (orderCode) params.set("order", orderCode);
  params.set("carrier", SIMULATED_CARRIER);
  params.set("tracking", trackingCode);
  params.set("url", trackingUrl);
  return {
    carrier: SIMULATED_CARRIER,
    trackingCode,
    trackingUrl,
    labelQr: `${SHIPMENT_LABEL_QR_SCHEME}?${params.toString()}`
  };
}
