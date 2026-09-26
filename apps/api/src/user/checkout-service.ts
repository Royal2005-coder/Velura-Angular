import { createHash, randomBytes, randomInt } from "node:crypto";
import { HttpError } from "../http.js";

const VIETNAMESE_PHONE = /^0(?:3|5|7|8|9)\d{8}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Dữ liệu liên hệ đã được chuẩn hóa trước khi checkout ghi vào đơn hàng. */
export interface CheckoutContact {
  fullName: string;
  phone: string;
  email: string | null;
}

/** Trạng thái đơn ban đầu được quyết định hoàn toàn từ phương thức thanh toán. */
export interface CheckoutPaymentState {
  method: "COD" | "ONLINE_PAYMENT";
  orderStatus: "pending" | "waiting_payment";
}

/** Thông tin kích hoạt lưu token hash ở DB và chỉ gửi raw token cho khách. */
export interface CheckoutActivation {
  token: string;
  tokenHash: string;
  expiresAt: string;
}

interface TimedOtpRequest {
  phone: string;
  at: number;
}

/** Bộ giới hạn gửi OTP checkout theo số điện thoại và địa chỉ IP. */
export class CheckoutOtpRateLimiter {
  private readonly requestsByPhone = new Map<string, number[]>();
  private readonly requestsByIp = new Map<string, TimedOtpRequest[]>();

  /**
   * Cho phép tối đa 3 lần/SĐT/15 phút và 5 SĐT khác nhau/IP/giờ.
   * Chỉ ghi nhận request sau khi vượt qua cả hai cổng.
   */
  consume(phone: string, ip: string, now = Date.now()): void {
    const phoneWindowStart = now - 15 * 60 * 1000;
    const phoneRequests = (this.requestsByPhone.get(phone) ?? []).filter((at) => at > phoneWindowStart);
    if (phoneRequests.length >= 3) {
      throw new HttpError(429, "OTP_PHONE_RATE_LIMIT", "Bạn đã yêu cầu OTP quá nhiều lần. Vui lòng thử lại sau 15 phút.");
    }

    const ipWindowStart = now - 60 * 60 * 1000;
    const ipRequests = (this.requestsByIp.get(ip) ?? []).filter((request) => request.at > ipWindowStart);
    const phones = new Set(ipRequests.map((request) => request.phone));
    if (!phones.has(phone) && phones.size >= 5) {
      throw new HttpError(429, "OTP_IP_RATE_LIMIT", "Đã có quá nhiều số điện thoại yêu cầu OTP từ kết nối này.");
    }

    phoneRequests.push(now);
    ipRequests.push({ phone, at: now });
    this.requestsByPhone.set(phone, phoneRequests);
    this.requestsByIp.set(ip, ipRequests);
  }
}

/** Lấy IP gốc từ proxy đầu tiên hoặc socket để áp dụng chống spam OTP. */
export function checkoutClientIp(headers: Record<string, unknown>, remoteAddress?: string): string {
  const forwarded = headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : String(forwarded ?? "").split(",")[0];
  return String(first || remoteAddress || "unknown").trim();
}

/**
 * Chuẩn hóa số Việt Nam về dạng 0xxxxxxxxx để OTP, tài khoản và đơn hàng dùng cùng khóa.
 */
export function normalizeVietnamesePhone(value: unknown): string {
  let phone = String(value ?? "").trim().replace(/[\s.-]/g, "");
  if (phone.startsWith("+84")) phone = `0${phone.slice(3)}`;
  else if (phone.startsWith("84") && phone.length === 11) phone = `0${phone.slice(2)}`;
  return phone;
}

/**
 * Kiểm tra hợp đồng liên hệ U1 ở backend. Email là tùy chọn; họ tên phải có ít nhất hai từ.
 */
export function validateCheckoutContact(input: {
  fullName: unknown;
  phone: unknown;
  email?: unknown;
}): CheckoutContact {
  const fullName = String(input.fullName ?? "").trim().replace(/\s+/g, " ");
  if (fullName.split(" ").filter(Boolean).length < 2) {
    throw new HttpError(422, "INVALID_FULL_NAME", "Họ và tên phải có ít nhất 2 từ");
  }

  const phone = normalizeVietnamesePhone(input.phone);
  if (!VIETNAMESE_PHONE.test(phone)) {
    throw new HttpError(422, "INVALID_PHONE", "Số điện thoại Việt Nam không hợp lệ");
  }

  const rawEmail = String(input.email ?? "").trim().toLowerCase();
  if (rawEmail && !EMAIL.test(rawEmail)) {
    throw new HttpError(422, "INVALID_EMAIL", "Email không hợp lệ");
  }
  return { fullName, phone, email: rawEmail || null };
}

/** Sinh OTP bằng nguồn ngẫu nhiên mật mã; không có mã cố định cho demo. */
export function generateCheckoutOtp(): string {
  return randomInt(0, 10_000).toString().padStart(4, "0");
}

/** Băm activation token để token thô không bao giờ nằm trong cơ sở dữ liệu. */
export function hashCheckoutActivationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Tạo activation token dùng một lần, hết hạn sau 24 giờ. */
export function createCheckoutActivation(now = Date.now()): CheckoutActivation {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashCheckoutActivationToken(token),
    expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString()
  };
}

/** Ánh xạ phương thức thanh toán sang trạng thái khởi tạo chuẩn của đơn. */
export function checkoutPaymentState(value: unknown): CheckoutPaymentState {
  const method = String(value ?? "").trim().toUpperCase();
  if (method === "COD") return { method: "COD", orderStatus: "pending" };
  if (!method) {
    throw new HttpError(422, "PAYMENT_METHOD_REQUIRED", "Phương thức thanh toán là bắt buộc");
  }
  return { method: "ONLINE_PAYMENT", orderStatus: "waiting_payment" };
}
