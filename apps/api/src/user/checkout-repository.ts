import { randomUUID } from "node:crypto";
import { HttpError } from "../http.js";
import { selectOne, updateRows } from "../supabase.js";
import { asJsonObject, type JsonObject } from "../types.js";
import type { CheckoutContact } from "./checkout-service.js";

/** Địa chỉ checkout được ghi thêm vào sổ địa chỉ của Member. */
export interface CheckoutAddressInput {
  detail: string;
  isDefault?: boolean;
}

/** Kết quả chuẩn bị để ghi sổ địa chỉ, tách riêng nhằm kiểm thử quy tắc không ghi đè. */
export interface SavedAddressBookUpdate {
  entry: JsonObject;
  addresses: JsonObject[];
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
