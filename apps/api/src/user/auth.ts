import { HttpError, readJson, sendJson } from "../http.js";
import { selectOne, insertRow, updateRows, getAuthUser } from "../supabase.js";
import { hashPassword, verifyPassword, signJwt } from "../auth-helper.js";
import { allowDevOtpBypass } from "../config.js";
import {
  assertNotLocked,
  clearLoginFailures,
  recordFailedLogin,
  resetStaleLoginFailures,
  type LoginLockUser
} from "../auth-lockout.js";
import { createNotification } from "./notifications.js";
import {
  asJsonObject,
  asString,
  errorMessage,
  isJsonObject,
  type AuthContext,
  type HeaderMap,
  type HttpRequest,
  type HttpResponse,
  type JsonObject,
  type UserProfile
} from "../types.js";

interface ProviderProfile {
  provider: string;
  email: string | null;
  name: string | null;
}

/**
 * True when value looks like a standard email address.
 */
export function validateEmail(email: unknown): boolean {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(asString(email));
}

/**
 * True when the phone has 8–20 digits (optional leading +).
 */
export function validatePhone(phone: unknown): boolean {
  const clean = String(phone || "").replace(/[^\d+]/g, "");
  return clean.length >= 8 && clean.length <= 20;
}

/**
 * True when the password meets AUTH-04 complexity rules.
 */
export function validatePassword(password: unknown): boolean {
  if (typeof password !== "string" || password.length < 8) return false;
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasDigitOrSpecial = /[\d\W]/.test(password);
  return hasUppercase && hasLowercase && hasDigitOrSpecial;
}

/**
 * Require a signed-in storefront profile or throw 401.
 */
export function requireUserAuth(context: AuthContext | null | undefined): UserProfile {
  if (!context || !context.profile || !context.profile.user_id) {
    throw new HttpError(401, "UNAUTHORIZED", "Đăng nhập là bắt buộc để thực hiện thao tác này");
  }
  return context.profile;
}

function normalizeSocialProvider(provider: unknown): "google" | "facebook" | null {
  const value = String(provider || "").toLowerCase();
  return value === "google" || value === "facebook" ? value : null;
}

function getSocialIdentity(authUser: unknown, provider: string): JsonObject | null {
  const identities = Array.isArray(asJsonObject(authUser).identities) ? asJsonObject(authUser).identities : [];
  if (!Array.isArray(identities)) return null;
  const found = identities.find((identity) => normalizeSocialProvider(asJsonObject(identity).provider) === provider);
  return found ? asJsonObject(found) : null;
}

function getProviderProfile(authUser: unknown): ProviderProfile | null {
  const raw = asJsonObject(authUser);
  const appMeta = asJsonObject(raw.app_metadata);
  const identities = Array.isArray(raw.identities) ? raw.identities : [];
  const firstIdentity = identities[0];
  const provider = normalizeSocialProvider(
    appMeta.provider
      || (Array.isArray(appMeta.providers) ? appMeta.providers[0] : null)
      || (firstIdentity ? asJsonObject(firstIdentity).provider : undefined)
  );

  if (!provider) return null;

  const identityData = asJsonObject(getSocialIdentity(authUser, provider)?.identity_data);
  const metadata = asJsonObject(raw.user_metadata);
  const providerEmail = identityData.email || metadata.email || raw.email || null;
  const providerName = identityData.full_name
    || identityData.name
    || identityData.user_name
    || metadata.full_name
    || metadata.name
    || (providerEmail ? String(providerEmail).split("@")[0] : null);

  return {
    provider,
    email: providerEmail ? String(providerEmail).slice(0, 255) : null,
    name: providerName ? String(providerName).slice(0, 100) : null
  };
}

function buildSocialAccounts(existingAccounts: unknown, providerProfile: ProviderProfile | null): JsonObject {
  const current = existingAccounts && typeof existingAccounts === "object" && !Array.isArray(existingAccounts)
    ? asJsonObject(existingAccounts)
    : {};
  if (!providerProfile?.provider) return current;

  return {
    ...current,
    [providerProfile.provider]: {
      provider: providerProfile.provider,
      providerEmail: providerProfile.email,
      providerName: providerProfile.name,
      linkedAt: new Date().toISOString()
    }
  };
}

function isMissingSocialAccountsColumn(error: unknown): boolean {
  const details = error instanceof HttpError ? asJsonObject(error.details) : asJsonObject(asJsonObject(error).details);
  const message = `${error instanceof Error ? error.message : ""} ${asString(details.message)} ${asString(details.msg)}`;
  const status = error instanceof HttpError ? error.status : Number(asJsonObject(error).status);
  return status === 400 && /social_accounts/i.test(message) && /schema cache|column/i.test(message);
}

async function saveSocialAccountsIfSupported(user: unknown, providerProfile: ProviderProfile | null): Promise<JsonObject> {
  const current = asJsonObject(user);
  if (!current.user_id || !providerProfile?.provider) return current;

  try {
    const rows = await updateRows("users", { user_id: `eq.${current.user_id}` }, {
      social_accounts: buildSocialAccounts(current.social_accounts, providerProfile),
      updated_at: new Date().toISOString()
    }, { silentError: true });
    const first = rows[0];
    return isJsonObject(first) ? first : current;
  } catch (err: unknown) {
    if (isMissingSocialAccountsColumn(err)) {
      console.warn("[social-login] users.social_accounts is not available yet; continuing without linked-account metadata.");
      return current;
    }
    throw err;
  }
}

/**
 * Storefront auth: signup, signin, OTP, password reset, and social login.
 */
export async function handleAuthRoute(
  req: HttpRequest,
  res: HttpResponse,
  action: string | undefined,
  corsHeaders: HeaderMap,
  context: AuthContext
): Promise<void> {
  // GET /api/user/auth/check-exists?email=...&phone=...
  if (action === "check-exists" && req.method === "GET") {
    const url = new URL(req.url || "/", "http://localhost");
    const email = url.searchParams.get("email");
    const phone = url.searchParams.get("phone");

    if (!email && !phone) {
      throw new HttpError(400, "BAD_REQUEST", "Cần truyền email hoặc phone");
    }

    let exists = false;
    if (email) {
      const user = await selectOne("users", { email: `eq.${email}` });
      exists = Boolean(user && user.is_active);
    } else if (phone) {
      if (!validatePhone(phone)) {
        throw new HttpError(400, "BAD_REQUEST", "Số điện thoại không đúng định dạng (10 số, bắt đầu bằng 0)");
      }
      const user = await selectOne("users", { phone: `eq.${phone}` });
      exists = Boolean(user && user.is_active);
    }

    return sendJson(res, 200, { exists }, corsHeaders);
  }

  // POST /api/user/auth/signup
  if (action === "signup" && req.method === "POST") {
    const body = await readJson(req);
    const { email, phone, password, full_name } = body;

    if (!full_name) {
      throw new HttpError(400, "BAD_REQUEST", "Họ và tên là bắt buộc");
    }
    if (!email && !phone) {
      throw new HttpError(400, "BAD_REQUEST", "Email hoặc Số điện thoại là bắt buộc");
    }
    if (email && !validateEmail(email)) {
      throw new HttpError(400, "BAD_REQUEST", "Email không đúng định dạng");
    }
    if (phone && !validatePhone(phone)) {
      throw new HttpError(400, "BAD_REQUEST", "Số điện thoại không đúng định dạng (10 số, bắt đầu bằng 0)");
    }
    if (!validatePassword(password)) {
      throw new HttpError(400, "BAD_REQUEST", "Mật khẩu phải dài tối thiểu 8 ký tự, bao gồm ít nhất một chữ hoa, một chữ thường và một số hoặc ký tự đặc biệt");
    }

    // Check uniqueness (AUTH-03)
    if (email) {
      const existingEmail = await selectOne("users", { email: `eq.${email}` });
      if (existingEmail) {
        throw new HttpError(400, "DUPLICATE_ACCOUNT", "Email đã được sử dụng trên hệ thống");
      }
    }
    if (phone) {
      const existingPhone = await selectOne("users", { phone: `eq.${phone}` });
      if (existingPhone) {
        throw new HttpError(400, "DUPLICATE_ACCOUNT", "Số điện thoại đã được sử dụng trên hệ thống");
      }
    }

    // Generate OTP code
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
    const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes (AUTH-05)

    console.log(`\n==================================================`);
    console.log(`[OTP VERIFICATION] Mã kích hoạt tài khoản của ${email || phone} là: ${otpCode}`);
    console.log(`==================================================\n`);

    // Create inactive user first (AUTH-05)
    const hashedPassword = hashPassword(asString(password));
    const newUser = asJsonObject(await insertRow("users", {
      email: email || null,
      phone: phone || null,
      password_hash: hashedPassword,
      full_name: full_name,
      is_active: false, // inactive until OTP verified
      otp_code: otpCode,
      otp_expires_at: otpExpiresAt,
      role: "member"
    }));

    return sendJson(res, 200, {
      success: true,
      otp_required: true,
      message: "Mã OTP xác minh đã được gửi. Vui lòng xác thực tài khoản.",
      email: newUser.email,
      phone: newUser.phone
    }, corsHeaders);
  }

  // POST /api/user/auth/otp-verify
  if (action === "otp-verify" && req.method === "POST") {
    const body = await readJson(req);
    const { identity, otp_code, purpose } = body;

    if (!identity || !otp_code) {
      throw new HttpError(400, "BAD_REQUEST", "Thiếu thông tin identity hoặc mã OTP");
    }

    const identityText = asString(identity);

    // Find user
    const query = identityText.includes("@") ? { email: `eq.${identityText}` } : { phone: `eq.${identityText}` };
    let user: JsonObject | null = await selectOne("users", query);
    
    // Auto-register guest only with the local OTP shortcut. Production requires a stored user + OTP.
    if (!user) {
      if (!allowDevOtpBypass() || (otp_code !== "123456" && otp_code !== "000000")) {
        throw new HttpError(400, "INVALID_OTP", "Mã OTP không chính xác hoặc đã hết hạn");
      }

      const randomPassword = "VeluraGuest" + Math.floor(1000 + Math.random() * 9000) + "!";
      const hashedPassword = hashPassword(randomPassword);
      user = asJsonObject(await insertRow("users", {
        email: identityText.includes("@") ? identityText : null,
        phone: identityText.includes("@") ? null : identityText,
        password_hash: hashedPassword,
        full_name: "Khách hàng Guest",
        is_active: true,
        role: "member",
        tier: "Standard"
      }));
    } else {
      // Validate OTP for existing user
      const now = new Date().toISOString();
      if (!user.otp_code || user.otp_code !== otp_code || (typeof user.otp_expires_at === "string" && user.otp_expires_at < now)) {
        if (!allowDevOtpBypass() || otp_code !== "123456") {
          throw new HttpError(400, "INVALID_OTP", "Mã OTP không chính xác hoặc đã hết hạn");
        }
      }
    }

    // Activate user if inactive
    const updates: JsonObject = {
      is_active: true,
      last_login_at: new Date().toISOString()
    };
    const wasInactive = !user.is_active;
    // Keep OTP for password reset flow because reset-password endpoint needs to check it.
    if (purpose !== "reset-password") {
      updates.otp_code = null;
      updates.otp_expires_at = null;
    }
    await updateRows("users", { user_id: `eq.${user.user_id}` }, updates);

    if (wasInactive) {
      await createNotification(
        asString(user.user_id),
        "system",
        "Chào mừng bạn đến với Velura! 🎉",
        "Chúc mừng bạn đã đăng ký tài khoản thành viên thành công. Nhận ngay ưu đãi thành viên và bắt đầu mua sắm ngay!",
        "/src/pages/products/list.html"
      );
    }

    const token = signJwt({ user_id: user.user_id, email: user.email, role: user.role });

    return sendJson(res, 200, {
      success: true,
      token,
      user: {
        user_id: user.user_id,
        email: user.email,
        phone: user.phone,
        full_name: user.full_name,
        role: user.role
      }
    }, corsHeaders);
  }

  // POST /api/user/auth/signin
  if (action === "signin" && req.method === "POST") {
    const body = await readJson(req);
    const { email, phone, password } = body;

    const identity = email || phone;
    if (!identity || !password) {
      throw new HttpError(400, "BAD_REQUEST", "Email/SĐT và mật khẩu là bắt buộc");
    }

    // Query user
    const query = email ? { email: `eq.${email}` } : { phone: `eq.${phone}` };
    const user = await selectOne("users", query);
    if (!user || typeof user.user_id !== "string") {
      throw new HttpError(401, "UNAUTHORIZED", "Thông tin đăng nhập không chính xác");
    }

    const lockUser: LoginLockUser = {
      user_id: user.user_id,
      login_fail_count: user.login_fail_count,
      locked_until: user.locked_until,
      updated_at: user.updated_at,
      created_at: user.created_at
    };
    const currentLock = await resetStaleLoginFailures(lockUser);
    assertNotLocked(currentLock);

    const isValidPassword = verifyPassword(asString(password), asString(user.password_hash));
    if (!isValidPassword) {
      await recordFailedLogin(currentLock);
    }

    await clearLoginFailures(user.user_id);

    // Check if user is active (AUTH-05 verification check)
    if (!user.is_active) {
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await updateRows("users", { user_id: `eq.${user.user_id}` }, {
        otp_code: otpCode,
        otp_expires_at: otpExpiresAt
      });

      console.log(`\n==================================================`);
      console.log(`[OTP VERIFICATION] Mã kích hoạt tài khoản của ${identity} là: ${otpCode}`);
      console.log(`==================================================\n`);

      return sendJson(res, 200, {
        success: false,
        otp_required: true,
        message: "Tài khoản chưa được xác minh. Vui lòng nhập mã OTP đã được gửi.",
        email: user.email,
        phone: user.phone
      }, corsHeaders);
    }

    const token = signJwt({ user_id: user.user_id, email: user.email, role: user.role });

    return sendJson(res, 200, {
      success: true,
      token,
      user: {
        user_id: user.user_id,
        email: user.email,
        phone: user.phone,
        full_name: user.full_name,
        role: user.role
      }
    }, corsHeaders);
  }

  // POST /api/user/auth/otp-send (Forgot Password / Reset OTP)
  if (action === "otp-send" && req.method === "POST") {
    const body = await readJson(req);
    const { identity } = body;

    if (!identity) {
      throw new HttpError(400, "BAD_REQUEST", "Email hoặc Số điện thoại là bắt buộc");
    }

    const identityText = asString(identity);
    const query = identityText.includes("@") ? { email: `eq.${identityText}` } : { phone: `eq.${identityText}` };
    const user = await selectOne("users", query);
    if (!user) {
      throw new HttpError(404, "USER_NOT_FOUND", "Không tìm thấy tài khoản liên kết với thông tin này");
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes (AUTH-05)

    await updateRows("users", { user_id: `eq.${user.user_id}` }, {
      otp_code: otpCode,
      otp_expires_at: otpExpiresAt
    });

    console.log(`\n==================================================`);
    console.log(`[OTP RESET] Mã khôi phục mật khẩu của ${identity} là: ${otpCode}`);
    console.log(`==================================================\n`);

    return sendJson(res, 200, {
      success: true,
      message: "Mã OTP đã được gửi thành công"
    }, corsHeaders);
  }

  // POST /api/user/auth/reset-password
  if (action === "reset-password" && req.method === "POST") {
    const body = await readJson(req);
    const { identity, otp_code, password } = body;

    if (!identity || !otp_code || !password) {
      throw new HttpError(400, "BAD_REQUEST", "Yêu cầu đầy đủ thông tin: định danh, OTP và mật khẩu mới");
    }
    if (!validatePassword(password)) {
      throw new HttpError(400, "BAD_REQUEST", "Mật khẩu phải dài tối thiểu 8 ký tự, bao gồm ít nhất một chữ hoa, một chữ thường và một số hoặc ký tự đặc biệt");
    }

    const identityText = asString(identity);
    const query = identityText.includes("@") ? { email: `eq.${identityText}` } : { phone: `eq.${identityText}` };
    const user = await selectOne("users", query);
    if (!user) {
      throw new HttpError(404, "USER_NOT_FOUND", "Tài khoản không tồn tại");
    }

    const now = new Date().toISOString();
    if (!user.otp_code || user.otp_code !== otp_code || (typeof user.otp_expires_at === "string" && user.otp_expires_at < now)) {
      if (!allowDevOtpBypass() || otp_code !== "123456") {
        throw new HttpError(400, "INVALID_OTP", "Mã xác thực không chính xác hoặc đã hết hạn");
      }
    }

    const hashedPassword = hashPassword(asString(password));
    await updateRows("users", { user_id: `eq.${user.user_id}` }, {
      password_hash: hashedPassword,
      login_fail_count: 0,
      locked_until: null,
      otp_code: null,
      otp_expires_at: null,
      is_active: true
    });

    return sendJson(res, 200, {
      success: true,
      message: "Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại."
    }, corsHeaders);
  }

  // POST /api/user/auth/social-login  (Google / Facebook via Supabase Auth)
  if (action === "social-login" && req.method === "POST") {
    const body = await readJson(req);
    const supabaseToken = body.token;

    if (!supabaseToken) {
      throw new HttpError(400, "BAD_REQUEST", "Thiếu Supabase access token");
    }

    // Verify token with Supabase and get user info
    let authUser;
    try {
      console.log("[social-login] Verifying Supabase token...");
      authUser = await getAuthUser(asString(supabaseToken));
      console.log("[social-login] authUser result:", authUser ? `OK (${authUser.email})` : "NULL");
    } catch (err: unknown) {
      const httpErr = err instanceof HttpError ? err : null;
      const details = asJsonObject(httpErr?.details);
      console.error("[social-login] getAuthUser error:", httpErr?.status, errorMessage(err), httpErr?.details);
      throw new HttpError(502, "SUPABASE_ERROR", "Không thể xác thực token: " + (asString(details.msg) || errorMessage(err)));
    }
    if (!authUser) {
      console.error("[social-login] authUser is null or missing email:", authUser);
      throw new HttpError(401, "INVALID_TOKEN", "Token Supabase không hợp lệ hoặc đã hết hạn");
    }

    const providerProfile = getProviderProfile(authUser);
    const email = authUser.email || providerProfile?.email || null;
    if (!email) {
      throw new HttpError(400, "PROVIDER_EMAIL_REQUIRED", "Tài khoản mạng xã hội chưa cung cấp email để tạo tài khoản Velura");
    }
    const authRaw = asJsonObject(authUser);
    const metadata = asJsonObject(authRaw.user_metadata);
    const fullName = metadata.full_name
      || metadata.name
      || providerProfile?.name
      || email.split("@")[0];
    const avatarRaw = metadata.avatar_url
      || metadata.picture
      || null;
    const avatar = avatarRaw ? String(avatarRaw).slice(0, 255) : null;
    const authUserId = authUser.id;
    const safeName = String(fullName).slice(0, 100);

    // Find existing user by email or auth_user_id
    let user: JsonObject | null = await selectOne("users", { email: `eq.${email}` });
    if (!user) {
      // Also check by auth_user_id in case email was added later
      user = await selectOne("users", { auth_user_id: `eq.${authUserId}` });
    }

    if (user) {
      const updates: JsonObject = {
        updated_at: new Date().toISOString()
      };
      if (!user.auth_user_id) updates.auth_user_id = authUserId;
      if (!user.avatar && avatar) updates.avatar = avatar;

      const updatedRows = await updateRows("users", { user_id: `eq.${user.user_id}` }, updates);
      const updated = updatedRows[0];
      if (isJsonObject(updated)) {
        user = updated;
      }
      user = await saveSocialAccountsIfSupported(user, providerProfile);
    } else {
      // Create new user from social profile
      const randomPassword = "SocialAuth" + Math.floor(1000 + Math.random() * 9000) + "!";
      user = asJsonObject(await insertRow("users", {
        email,
        password_hash: hashPassword(randomPassword),
        full_name: safeName,
        avatar,
        auth_user_id: authUserId,
        is_active: true,
        role: "member",
        tier: "Standard"
      }));
      user = await saveSocialAccountsIfSupported(user, providerProfile);

      // Welcome notification
      await createNotification(
        asString(user.user_id),
        "system",
        "Chào mừng bạn đến với Velura! 🎉",
        "Tài khoản của bạn đã được tạo qua đăng nhập mạng xã hội. Bắt đầu mua sắm ngay!",
        "/src/pages/products/list.html"
      );
    }

    const veluraToken = signJwt({ user_id: user.user_id, email: user.email, role: user.role });

    return sendJson(res, 200, {
      success: true,
      token: veluraToken,
      user: {
        user_id: user.user_id,
        email: user.email,
        phone: user.phone,
        full_name: user.full_name || safeName,
        role: user.role,
        avatar: user.avatar || avatar
      }
    }, corsHeaders);
  }

  throw new HttpError(404, "NOT_FOUND", "Action không tồn tại");
}
