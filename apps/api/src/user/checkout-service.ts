import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { hashPassword, signJwt, verifyJwt } from "../auth-helper.js";
import { HttpError } from "../http.js";
import { asJsonObject, asString, type AuthContext, type JsonObject } from "../types.js";
import type { CheckoutAddressInput, CheckoutRepository } from "./checkout-repository.js";
import { buildCartLines, loadCatalog, loadCategoryTree } from "./cart-catalog.js";
import { priceOrder, shippingMethodFromClaim, type PricedOrderLine } from "./order-pricing.js";
import { recordVoucherRedemption, resolveOrderVoucher } from "./vouchers.js";

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

/** Phiên OTP checkout chỉ tồn tại trong bộ nhớ API và không đi ra HTTP. */
export interface CheckoutOtpSession {
  otpCode: string;
  expiresAt: number;
  contact: CheckoutContact;
  attempts: number;
}

/** Một dòng hàng đã được service giá xác nhận trước khi repository ghi DB. */
export interface PersistedCheckoutItem {
  variantId: string;
  productName: string;
  productImage: unknown;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

/** DTO nội bộ để service tạo đơn; mọi số tiền đã được backend chốt trước đó. */
export interface PersistCheckoutOrderInput {
  userId: string;
  /** Immutable buyer classification and retry identity for this checkout. */
  isGuest?: boolean;
  idempotencyKey?: string;
  contact: CheckoutContact;
  shippingAddress: string;
  shippingFee: number;
  voucherId: string | null;
  discountAmount: number;
  subtotal: number;
  totalAmount: number;
  paymentMethod: string;
  paymentProvider: string;
  orderStatus: "pending" | "waiting_payment";
  orderCode: string;
  internalNote: string | null;
  items: readonly PersistedCheckoutItem[];
}

/** Kết quả service tạo đơn và các dòng hàng tương ứng. */
export interface PersistedCheckoutOrder {
  order: JsonObject;
  items: JsonObject[];
}

/** Giá và voucher đã được backend chốt từ catalog, không tin số tiền trình duyệt gửi. */
export interface CheckoutQuote {
  items: PricedOrderLine[];
  subtotal: number;
  shippingFee: number;
  voucherId: string | null;
  discountAmount: number;
  totalAmount: number;
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

/** Quản lý vòng đời OTP checkout, tách rule khỏi HTTP router. */
export class CheckoutOtpService {
  private readonly sessions = new Map<string, CheckoutOtpSession>();
  private readonly consumedPhones = new Set<string>();
  private readonly consumedTokens = new Set<string>();

  constructor(private readonly limiter = new CheckoutOtpRateLimiter()) {}

  /** Chuẩn hóa contact, áp rate limit và tạo OTP hiệu lực 60 giây. */
  issue(input: { fullName: unknown; phone: unknown; email?: unknown; ip: string }, now = Date.now()): CheckoutOtpSession {
    const contact = validateCheckoutContact(input);
    this.limiter.consume(contact.phone, input.ip, now);
    const session: CheckoutOtpSession = {
      otpCode: generateCheckoutOtp(),
      expiresAt: now + 60 * 1000,
      contact,
      attempts: 0
    };
    this.sessions.set(contact.phone, session);
    this.consumedPhones.delete(contact.phone);
    return session;
  }

  /** Xác minh OTP nhưng chưa tiêu thụ để router còn có thể chốt lại giá/voucher. */
  verify(phoneInput: unknown, otpInput: unknown, now = Date.now()): CheckoutOtpSession {
    const phone = normalizeVietnamesePhone(phoneInput);
    const session = this.sessions.get(phone);
    if (!session) throw new HttpError(400, "INVALID_OTP", "Không tìm thấy phiên xác thực. Vui lòng nhận lại mã OTP.");
    if (session.attempts >= 5) throw new HttpError(403, "SESSION_LOCKED", "Phiên xác thực đã bị khóa. Vui lòng đặt lại đơn hàng.");
    if (session.expiresAt < now) throw new HttpError(400, "EXPIRED_OTP", "Mã xác thực đã hết hạn.");
    if (session.otpCode !== String(otpInput ?? "")) {
      session.attempts += 1;
      if (session.attempts >= 5) {
        this.sessions.delete(phone);
        throw new HttpError(403, "SESSION_LOCKED", "Phiên xác thực bị khóa do nhập sai quá 5 lần. Vui lòng đặt lại đơn hàng.");
      }
      this.sessions.set(phone, session);
      throw new HttpError(400, "INVALID_OTP", `Mã OTP không hợp lệ. Bạn còn ${5 - session.attempts} lần thử.`);
    }
    return session;
  }

  /** Tiêu thụ OTP đúng một lần sau khi giá và voucher đã được chốt thành công. */
  consume(phoneInput: unknown, tokenInput?: unknown): void {
    const phone = normalizeVietnamesePhone(phoneInput);
    this.sessions.delete(phone);
    this.consumedPhones.add(phone);
    if (tokenInput) {
      this.consumedTokens.add(asString(tokenInput));
    }
  }

  /** Successful OTP grants 15 minutes to finish the same checkout challenge. */
  prove(phoneInput: unknown, otpInput: unknown): string {
    const session = this.verify(phoneInput, otpInput);
    return signJwt({
      purpose: "guest_checkout",
      phone: session.contact.phone,
      contact: session.contact,
      challenge: this.challenge(session)
    }, 15 * 60);
  }

  /** A proof survives code expiry and is invalidated by consumption or resending. */
  verifyForCheckout(phoneInput: unknown, otpInput: unknown, tokenInput: unknown): CheckoutOtpSession {
    if (!tokenInput) return this.verify(phoneInput, otpInput);
    const phone = normalizeVietnamesePhone(phoneInput);
    const rawToken = asString(tokenInput);
    const claims = verifyJwt(rawToken);
    if (!claims || claims.purpose !== "guest_checkout" || claims.phone !== phone) {
      throw new HttpError(401, "CHECKOUT_PROOF_REQUIRED", "Xác thực checkout đã hết hạn hoặc không khớp số điện thoại.");
    }
    if (this.consumedPhones.has(phone) || this.consumedTokens.has(rawToken)) {
      throw new HttpError(401, "CHECKOUT_PROOF_REQUIRED", "Phiên xác thực thanh toán đã được sử dụng. Vui lòng xác thực lại SĐT.");
    }
    const session = this.sessions.get(phone);
    if (session) {
      if (claims.challenge && claims.challenge !== this.challenge(session)) {
        throw new HttpError(401, "CHECKOUT_PROOF_REQUIRED", "Xác thực checkout đã hết hạn hoặc không khớp số điện thoại.");
      }
      return session;
    }
    // Phục vụ môi trường serverless: tái tạo session từ token JWT đã được xác thực chữ ký số HMAC
    const contact = (claims.contact as CheckoutContact) || { fullName: "", phone, email: null };
    return {
      otpCode: "",
      expiresAt: (typeof claims.exp === "number" ? claims.exp : Math.floor(Date.now() / 1000) + 900) * 1000,
      contact,
      attempts: 0
    };
  }

  private challenge(session: CheckoutOtpSession): string {
    return createHash("sha256").update(JSON.stringify(session)).digest("hex");
  }
}

/** Service ứng dụng checkout; giữ rule tồn kho và điều phối repository. */
export class CheckoutService {
  constructor(private readonly repository: CheckoutRepository) {}

  /** Trả về các dòng không đủ tồn kho; router chỉ quyết định mã HTTP. */
  async unavailableItems(items: readonly JsonObject[]): Promise<JsonObject[]> {
    const unavailable: JsonObject[] = [];
    for (const item of items) {
      const variant = await this.repository.findVariant(asString(item.variant_id));
      if (!variant) throw new HttpError(400, "NOT_FOUND", "Không tìm thấy biến thể sản phẩm");
      const available = Number(variant.stock_quantity) - Number(variant.reserved_quantity || 0);
      if (Number(item.quantity) > available) {
        unavailable.push({
          variant_id: item.variant_id,
          product_name: item.product_name,
          color: item.color,
          size: item.size,
          requested: item.quantity,
          available: Math.max(0, available)
        });
      }
    }
    return unavailable;
  }

  /** Chốt giá catalog, phí giao và voucher trong tầng nghiệp vụ checkout. */
  async quote(
    context: AuthContext,
    rawItems: readonly JsonObject[],
    claimedFee: unknown,
    claimedMethod: unknown,
    voucherId: string | null,
    declineVoucher: boolean
  ): Promise<CheckoutQuote> {
    const claims = rawItems.map((item) => ({
      variantId: asString(item.variant_id),
      quantity: Number(item.quantity),
      claimedUnitPrice: Number(item.unit_price)
    }));
    const [catalog, tree] = await Promise.all([
      loadCatalog(claims.map((line) => line.variantId)),
      loadCategoryTree()
    ]);
    const priced = priceOrder(claims, catalog, shippingMethodFromClaim(claimedFee, claimedMethod));
    if (!priced.ok) {
      throw new HttpError(400, priced.code, priced.message, {
        variant_id: priced.variantId,
        claimed_unit_price: priced.claimedUnitPrice,
        catalog_unit_price: priced.catalogUnitPrice
      });
    }
    const cartLines = buildCartLines(
      priced.items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
      catalog,
      tree
    );
    const voucher = await resolveOrderVoucher(
      context,
      priced.subtotal,
      priced.shippingFee,
      voucherId,
      declineVoucher,
      { lines: cartLines.lines, categoryNameById: tree.nameById }
    );
    return {
      items: priced.items,
      subtotal: priced.subtotal,
      shippingFee: priced.shippingFee,
      voucherId: voucher.voucherId,
      discountAmount: voucher.discountAmount,
      totalAmount: Math.max(0, priced.subtotal + priced.shippingFee - voucher.discountAmount)
    };
  }

  /** Ghi nhận ngân sách/lượt dùng voucher sau khi đơn đã được tạo. */
  /** Reads existing account ownership to constrain OTP delivery destinations. */
  async findUserByPhone(phone: string): Promise<JsonObject | null> { return this.repository.findUserByPhone(phone); }

  async recordVoucher(voucherId: string | null, discountAmount: number): Promise<void> {
    if (this.repository.createOrderBundle) return;
    if (voucherId) await recordVoucherRedemption(voucherId, discountAmount);
  }

  /** Tìm hoặc tạo Guest bất hoạt và phát hành token kích hoạt dùng một lần. */
  async resolveGuest(contact: CheckoutContact, shippingAddress: string): Promise<{
    user: JsonObject;
    activation: CheckoutActivation | null;
    existingMember: boolean;
  }> {
    let user = await this.repository.findUserByPhone(contact.phone);
    if (!user && contact.email) {
      const byEmail = await this.repository.findUserByEmail(contact.email);
      // Chỉ gắn với tài khoản tìm theo email nếu tài khoản đó chưa có SĐT hoặc khớp chính xác SĐT này.
      // Tuyệt đối không gắn vào tài khoản của SĐT khác tránh chiếm quyền tài khoản và lỗi vượt hạn mức voucher chéo.
      if (byEmail && (!byEmail.phone || normalizeVietnamesePhone(asString(byEmail.phone)) === contact.phone)) {
        user = byEmail;
      }
    }
    const existingMember = Boolean(user?.is_active);
    const activation = existingMember ? null : createCheckoutActivation();
    const now = new Date().toISOString();
    const savedAddresses = [{ name: contact.fullName, phone: contact.phone, detail: shippingAddress, is_default: true }];
    if (!user) {
      try {
        user = await this.repository.createGuestUser({
          full_name: contact.fullName,
          phone: contact.phone,
          email: contact.email,
          password_hash: hashPassword(randomUUID() + randomUUID()),
          role: "member",
          is_active: false,
          activation_token_hash: activation?.tokenHash,
          activation_expires_at: activation?.expiresAt,
          saved_addresses: savedAddresses,
          created_at: now,
          updated_at: now
        });
      } catch {
        // Nếu email trùng với tài khoản khác (users_email_key), tạo user guest với email: null theo đúng SĐT.
        // Đơn hàng và email kích hoạt vẫn được gửi chính xác tới contact.email thông qua shipping_email.
        user = await this.repository.createGuestUser({
          full_name: contact.fullName,
          phone: contact.phone,
          email: null,
          password_hash: hashPassword(randomUUID() + randomUUID()),
          role: "member",
          is_active: false,
          activation_token_hash: activation?.tokenHash,
          activation_expires_at: activation?.expiresAt,
          saved_addresses: savedAddresses,
          created_at: now,
          updated_at: now
        });
      }
    } else if (!existingMember) {
      await this.repository.updateGuestUser(asString(user.user_id), {
        activation_token_hash: activation?.tokenHash,
        activation_expires_at: activation?.expiresAt,
        saved_addresses: savedAddresses,
        updated_at: now
      });
      user = { ...user, email: user.email || contact.email };
    }
    return { user, activation, existingMember };
  }

  /** Đổi token kích hoạt hợp lệ thành tài khoản Member có mật khẩu do khách tự đặt. */
  async activateGuest(tokenInput: unknown, passwordInput: unknown, now = Date.now()): Promise<JsonObject> {
    const token = asString(tokenInput).trim();
    const password = asString(passwordInput);
    if (!token) throw new HttpError(400, "ACTIVATION_TOKEN_REQUIRED", "Liên kết kích hoạt không hợp lệ");
    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d\W]).{8,}$/.test(password)) {
      throw new HttpError(422, "INVALID_PASSWORD", "Mật khẩu phải dài tối thiểu 8 ký tự, gồm chữ hoa, chữ thường và số hoặc ký tự đặc biệt");
    }
    const user = await this.repository.findUserByActivationHash(hashCheckoutActivationToken(token));
    if (!user || !user.activation_expires_at || new Date(asString(user.activation_expires_at)).getTime() <= now) {
      throw new HttpError(400, "ACTIVATION_TOKEN_INVALID", "Liên kết kích hoạt không hợp lệ hoặc đã hết hạn");
    }
    await this.repository.activateGuestUser(asString(user.user_id), hashPassword(password));
    return user;
  }

  /** Ghi đơn, payment và item qua repository; COD mới trừ tồn ngay. */
  async persistOrder(input: PersistCheckoutOrderInput): Promise<PersistedCheckoutOrder> {
    if (this.repository.createOrderBundle) return this.repository.createOrderBundle(input);
    const now = new Date().toISOString();
    const order = await this.repository.createOrder({
      user_id: input.userId,
      is_guest: input.isGuest === true,
      status: input.orderStatus,
      shipping_name: input.contact.fullName,
      shipping_phone: input.contact.phone,
      shipping_email: input.contact.email,
      shipping_address: input.shippingAddress,
      shipping_fee: input.shippingFee,
      voucher_id: input.voucherId,
      discount_amount: input.discountAmount,
      subtotal: input.subtotal,
      total_amount: input.totalAmount,
      payment_method: input.paymentMethod,
      order_code: input.orderCode,
      internal_note: input.internalNote,
      stock_committed_at: input.paymentMethod === "COD" ? now : null,
      created_at: now,
      updated_at: now
    });
    if (input.paymentMethod !== "COD" && !["stripe", "vnpay", "momo"].includes(input.paymentProvider.toLowerCase())) {
      const provider = input.paymentProvider.toLowerCase();
      await this.repository.createPayment({
        order_id: order.order_id,
        amount: input.totalAmount,
        payment_method: input.paymentMethod,
        payment_provider: provider,
        payment_status: "pending",
        gateway_transaction_ref: `pay_${provider}_${input.orderCode}`,
        created_at: now
      });
    }
    const createdItems: JsonObject[] = [];
    for (const item of input.items) {
      createdItems.push(await this.repository.createOrderItem({
        order_id: order.order_id,
        variant_id: item.variantId,
        product_name: item.productName,
        product_image: item.productImage || null,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        subtotal_item: item.subtotal
      }));
      if (input.paymentMethod === "COD") {
        const variant = await this.repository.findVariant(item.variantId);
        if (variant) {
          await this.repository.updateVariantStock(item.variantId, Math.max(0, Number(variant.stock_quantity) - item.quantity));
        }
      }
    }
    return { order: asJsonObject(order), items: createdItems.map(asJsonObject) };
  }

  /** Lưu địa chỉ khi Member chủ động chọn tùy chọn này. */
  async saveMemberAddress(userId: string, contact: CheckoutContact, input: CheckoutAddressInput): Promise<JsonObject> {
    return this.repository.appendAddress(userId, contact, input);
  }

  /** Ghi outbox sau khi email checkout đã gửi thành công. */
  async recordSentEmail(input: JsonObject): Promise<void> {
    await this.repository.createEmailOutbox(input);
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
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
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
