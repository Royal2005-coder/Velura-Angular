import { randomUUID } from "node:crypto";
import { HttpError } from "../http.js";
import { insertRow, selectOne, updateRows } from "../supabase.js";
import { asJsonObject, type JsonObject } from "../types.js";
import type { CheckoutContact } from "./checkout-service.js";

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
    findVariant: (variantId) => selectOne("variant", { variant_id: `eq.${variantId}` }),
    findUserByPhone: (phone) => selectOne("users", { phone: `eq.${phone}` }),
    findUserByEmail: (email) => selectOne("users", { email: `eq.${email}` }),
    findUserByActivationHash: (tokenHash) => selectOne("users", { activation_token_hash: `eq.${tokenHash}` }),
    createGuestUser: async (input) => asJsonObject(await insertRow("users", input)),
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
