import { randomUUID } from "node:crypto";
import { HttpError } from "../http.js";
import { callRpc, insertRow, selectOne, updateRows } from "../supabase.js";
import { asJsonObject, asString, type JsonObject } from "../types.js";
import type { CheckoutContact, PersistCheckoutOrderInput, PersistedCheckoutOrder } from "./checkout-service.js";

/** Địa chỉ checkout được ghi thêm vào sổ địa chỉ của Member. */
export interface CheckoutAddressInput {
  detail: string;
  address?: string;
  province?: string;
  district?: string;
  ward?: string;
  isDefault?: boolean;
}

/** Kết quả chuẩn bị để ghi sổ địa chỉ, tách riêng nhằm kiểm thử quy tắc không ghi đè. */
export interface SavedAddressBookUpdate {
  entry: JsonObject;
  addresses: JsonObject[];
}

/** Cổng dữ liệu checkout; service không biết chi tiết PostgREST/Supabase. */
export interface CheckoutRepository {
  /** Commit order, stock and voucher usage in one transaction. */
  createOrderBundle?(input: PersistCheckoutOrderInput): Promise<PersistedCheckoutOrder>;
  /** Tìm biến thể để kiểm tồn kho tại thời điểm đặt hàng. */
  findVariant(variantId: string): Promise<JsonObject | null>;
  /** Tìm tài khoản theo số điện thoại đã chuẩn hóa. */
  findUserByPhone(phone: string): Promise<JsonObject | null>;
  /** Tìm tài khoản theo email đã chuẩn hóa. */
  findUserByEmail(email: string): Promise<JsonObject | null>;
  /** Tìm Guest theo hash token kích hoạt dùng một lần. */
  findUserByActivationHash(tokenHash: string): Promise<JsonObject | null>;
  /** Tạo tài khoản Guest chưa kích hoạt. */
  createGuestUser(input: JsonObject): Promise<JsonObject>;
  /** Cập nhật token kích hoạt của Guest đã tồn tại. */
  updateGuestUser(userId: string, input: JsonObject): Promise<void>;
  /** Kích hoạt tài khoản và xóa token để không thể dùng lại. */
  activateGuestUser(userId: string, passwordHash: string): Promise<void>;
  /** Ghi một đơn hàng đã được service chốt giá và trạng thái. */
  createOrder(input: JsonObject): Promise<JsonObject>;
  /** Ghi phiên thanh toán online của đơn. */
  createPayment(input: JsonObject): Promise<void>;
  /** Ghi một dòng hàng thuộc đơn. */
  createOrderItem(input: JsonObject): Promise<JsonObject>;
  /** Cập nhật số lượng tồn của một biến thể sau khi service tính số mới. */
  updateVariantStock(variantId: string, quantity: number): Promise<void>;
  /** Ghi vết email đã gửi để worker không gửi lặp. */
  createEmailOutbox(input: JsonObject): Promise<void>;
  /** Thêm địa chỉ checkout vào sổ địa chỉ của Member. */
  appendAddress(userId: string, contact: CheckoutContact, input: CheckoutAddressInput): Promise<JsonObject>;
}

/** Tạo repository checkout dùng Supabase; đây là lớp duy nhất của checkout gọi helper DB. */
export function createCheckoutRepository(): CheckoutRepository {
  return {
    async createOrderBundle(input) {
      try {
        const payload = {
          ...input,
          userId: input.userId ? String(input.userId).trim() || null : null,
          voucherId: input.voucherId ? String(input.voucherId).trim() || null : null
        };
        const result = asJsonObject(await callRpc("velura_create_checkout_order", { p_input: payload }));
        return { order: asJsonObject(result.order), items: Array.isArray(result.items) ? result.items.map(asJsonObject) : [] };
      } catch (error: unknown) {
        if (error instanceof HttpError && error.code === "SUPABASE_ERROR") {
          const details = asJsonObject(error.details);
          const rawCode = asString(details.message) || asString(details.code) || "";
          if (rawCode === "INSUFFICIENT_STOCK") {
            throw new HttpError(409, "INSUFFICIENT_STOCK", "Một số sản phẩm trong giỏ hàng đã hết hàng hoặc không đủ tồn kho.", details);
          }
          if (rawCode === "VOUCHER_CHANGED") {
            throw new HttpError(409, "VOUCHER_CHANGED", "Mã giảm giá đã thay đổi hoặc hết lượt sử dụng. Vui lòng kiểm tra lại đơn hàng.", details);
          }
          if (rawCode === "ORDER_TOTAL_MISMATCH") {
            throw new HttpError(422, "ORDER_TOTAL_MISMATCH", "Tổng tiền đơn hàng không khớp với bảng giá hiện tại. Vui lòng thử lại.", details);
          }
          if (rawCode === "INVALID_PAYMENT_METHOD") {
            throw new HttpError(422, "INVALID_PAYMENT_METHOD", "Phương thức thanh toán không hợp lệ.", details);
          }
          if (rawCode === "DUPLICATE_VARIANT") {
            throw new HttpError(422, "DUPLICATE_VARIANT", "Sản phẩm trong giỏ hàng bị trùng lặp.", details);
          }
          if (rawCode === "ORDER_ITEMS_REQUIRED") {
            throw new HttpError(422, "ORDER_ITEMS_REQUIRED", "Đơn hàng phải có ít nhất một sản phẩm.", details);
          }
          if (rawCode === "INVALID_QUANTITY") {
            throw new HttpError(422, "INVALID_QUANTITY", "Số lượng sản phẩm không hợp lệ.", details);
          }
          if (rawCode === "VARIANT_NOT_FOUND") {
            throw new HttpError(404, "VARIANT_NOT_FOUND", "Không tìm thấy thông tin sản phẩm trong hệ thống.", details);
          }
        }
        throw error;
      }
    },
    findVariant: (variantId) => selectOne("variant", { variant_id: `eq.${variantId}` }),
    findUserByPhone: (phone) => selectOne("users", { phone: `eq.${phone}` }),
    findUserByEmail: (email) => selectOne("users", { email: `eq.${email}` }),
    findUserByActivationHash: (tokenHash) => selectOne("users", { activation_token_hash: `eq.${tokenHash}` }),
    createGuestUser: async (input) => {
      try {
        return asJsonObject(await insertRow("users", input));
      } catch (error: unknown) {
        if (error instanceof HttpError && error.code === "SUPABASE_ERROR") {
          const details = asJsonObject(error.details);
          const rawMsg = asString(details.message) || asString(details.details) || "";
          if (rawMsg.includes("users_email_key")) {
            throw new HttpError(409, "EMAIL_ALREADY_EXISTS", "Email này đã thuộc về tài khoản khác. Vui lòng đăng nhập hoặc đổi email.", details);
          }
          if (rawMsg.includes("users_phone_key")) {
            throw new HttpError(409, "PHONE_ALREADY_EXISTS", "Số điện thoại này đã được sử dụng. Vui lòng đăng nhập để tiếp tục.", details);
          }
        }
        throw error;
      }
    },
    updateGuestUser: async (userId, input) => {
      await updateRows("users", { user_id: `eq.${userId}` }, input);
    },
    activateGuestUser: async (userId, passwordHash) => {
      await updateRows("users", { user_id: `eq.${userId}` }, {
        password_hash: passwordHash,
        is_active: true,
        activation_token_hash: null,
        activation_expires_at: null,
        updated_at: new Date().toISOString()
      });
      const user = await selectOne("users", { user_id: `eq.${userId}` });
      if (user?.phone) {
        await updateRows("orders", { shipping_phone: `eq.${user.phone}` }, {
          user_id: userId,
          is_guest: false,
          updated_at: new Date().toISOString()
        });
      }
    },
    createOrder: async (input) => asJsonObject(await insertRow("orders", input)),
    createPayment: async (input) => {
      await insertRow("payment", input);
    },
    createOrderItem: async (input) => asJsonObject(await insertRow("order_item", input)),
    updateVariantStock: async (variantId, quantity) => {
      await updateRows("variant", { variant_id: `eq.${variantId}` }, { stock_quantity: quantity });
    },
    createEmailOutbox: async (input) => {
      await insertRow("email_outbox", input);
    },
    appendAddress: appendCheckoutAddress
  };
}

/** Tạo bản cập nhật sổ địa chỉ nhưng luôn bảo toàn các địa chỉ đã có. */
export function buildSavedAddressBook(
  current: readonly JsonObject[],
  contact: CheckoutContact,
  input: CheckoutAddressInput,
  addressId = `addr_${randomUUID()}`
): SavedAddressBookUpdate {
  const detail = String(input.detail ?? "").trim();
  if (!detail) throw new HttpError(422, "INVALID_ADDRESS", "Địa chỉ giao hàng là bắt buộc");
  const makeDefault = current.length === 0 || input.isDefault === true;
  const normalized = makeDefault
    ? current.map((address) => ({ ...address, is_default: false }))
    : current.map((address) => ({ ...address }));
  const entry: JsonObject = {
    id: addressId,
    name: contact.fullName,
    phone: contact.phone,
    detail,
    address: String(input.address ?? detail).trim(),
    province: String(input.province ?? "").trim(),
    district: String(input.district ?? "").trim(),
    ward: String(input.ward ?? "").trim(),
    is_default: makeDefault
  };
  return { entry, addresses: [...normalized, entry] };
}

/**
 * Thêm địa chỉ mới vào cuối sổ địa chỉ của đúng Member; không ghi đè địa chỉ cũ.
 */
export async function appendCheckoutAddress(
  userId: string,
  contact: CheckoutContact,
  input: CheckoutAddressInput
): Promise<JsonObject> {
  const user = await selectOne("users", { user_id: `eq.${userId}` });
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "Không tìm thấy người dùng để lưu địa chỉ");

  const current = Array.isArray(user.saved_addresses)
    ? user.saved_addresses.map((address) => asJsonObject(address))
    : [];
  const update = buildSavedAddressBook(current, contact, input);

  await updateRows("users", { user_id: `eq.${userId}` }, {
    saved_addresses: update.addresses,
    updated_at: new Date().toISOString()
  });
  return update.entry;
}
