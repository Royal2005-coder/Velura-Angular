import { HttpError, readJson, sendJson } from "../http.js";
import { updateRows } from "../supabase.js";
import { requireUserAuth, validatePhone } from "./auth.js";

export async function handleProfileRoute(req, res, subRoute, corsHeaders, context) {
  const profile = requireUserAuth(context);

  if (subRoute === "profile") {
    // GET /api/user/profile
    if (req.method === "GET") {
      const { password_hash, otp_code, otp_expires_at, ...cleanProfile } = profile;
      return sendJson(res, 200, cleanProfile, corsHeaders);
    }

    // PATCH /api/user/profile
    if (req.method === "PATCH") {
      const body = await readJson(req);
      const { full_name, date_of_birth, gender, avatar } = body;

      const updates = {};
      if (full_name !== undefined) {
        const normalizedName = String(full_name || "").trim();
        if (normalizedName.length < 2 || normalizedName.length > 120) {
          throw new HttpError(422, "INVALID_FULL_NAME", "Họ và tên phải có từ 2 đến 120 ký tự");
        }
        updates.full_name = normalizedName;
      }
      if (date_of_birth !== undefined && date_of_birth !== null && date_of_birth !== "") {
        updates.date_of_birth = validateDateOfBirth(date_of_birth);
      }
      if (gender !== undefined && gender !== null && gender !== "") {
        const allowedGenders = new Set(["Nam", "Nữ", "Khác"]);
        if (!allowedGenders.has(gender)) {
          throw new HttpError(422, "INVALID_GENDER", "Giới tính không hợp lệ");
        }
        updates.gender = gender;
      }
      if (avatar !== undefined) updates.avatar = String(avatar || "").trim() || null;
      updates.updated_at = new Date().toISOString();

      const updatedRows = await updateRows("users", { user_id: `eq.${profile.user_id}` }, updates);
      const updated = updatedRows[0];
      if (!updated) {
        throw new HttpError(404, "USER_NOT_FOUND", "Không tìm thấy người dùng");
      }
      const { password_hash, otp_code, otp_expires_at, ...cleanProfile } = updated;
      return sendJson(res, 200, cleanProfile, corsHeaders);
    }
  }

  if (subRoute === "addresses") {
    // PATCH /api/user/addresses
    if (req.method === "PATCH") {
      const body = await readJson(req);
      const { addresses } = body; // JSON array expected

      if (!Array.isArray(addresses)) {
        throw new HttpError(400, "BAD_REQUEST", "Addresses phải là một mảng JSON");
      }

      for (const addr of addresses) {
        const phone = addr.phone || addr.recipient_phone;
        if (!phone || !validatePhone(phone)) {
          throw new HttpError(400, "BAD_REQUEST", "Số điện thoại trong địa chỉ giao hàng không hợp lệ (10 số, bắt đầu bằng 0)");
        }
      }

      await updateRows("users", { user_id: `eq.${profile.user_id}` }, {
        saved_addresses: addresses,
        updated_at: new Date().toISOString()
      });

      return sendJson(res, 200, { success: true, addresses }, corsHeaders);
    }
  }

  throw new HttpError(404, "NOT_FOUND", "Route profile not found");
}

function validateDateOfBirth(value) {
  const normalized = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) {
    throw new HttpError(422, "INVALID_DATE_OF_BIRTH", "Ngày sinh phải đúng định dạng YYYY-MM-DD");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const isRealDate = date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
  if (!isRealDate || date > new Date()) {
    throw new HttpError(422, "INVALID_DATE_OF_BIRTH", "Ngày sinh không hợp lệ");
  }
  if (year < 1900) {
    throw new HttpError(422, "INVALID_DATE_OF_BIRTH", "Năm sinh không hợp lệ");
  }
  return normalized;
}
