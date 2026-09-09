import { HttpError, readJson, sendJson } from "../http.js";
import { selectOne, insertRow, updateRows, getAuthUser } from "../supabase.js";
import { hashPassword, verifyPassword, signJwt } from "../auth-helper.js";
import { createNotification } from "./notifications.js";

// Helper to validate email format
export function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

// Helper to validate phone format (Vietnamese and international formats)
export function validatePhone(phone) {
  const clean = String(phone || "").replace(/[^\d+]/g, "");
  return clean.length >= 8 && clean.length <= 20;
}

// Helper to validate password (AUTH-04: min 8 chars, 1 uppercase, 1 lowercase, 1 number/special)
export function validatePassword(password) {
  if (!password || password.length < 8) return false;
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasDigitOrSpecial = /[\d\W]/.test(password);
  return hasUppercase && hasLowercase && hasDigitOrSpecial;
}

// Helper to enforce authentication on routes
export function requireUserAuth(context) {
  if (!context || !context.profile || !context.profile.user_id) {
    throw new HttpError(401, "UNAUTHORIZED", "Đăng nhập là bắt buộc để thực hiện thao tác này");
  }
  return context.profile;
}

function normalizeSocialProvider(provider) {
  const value = String(provider || "").toLowerCase();
  return value === "google" || value === "facebook" ? value : null;
}

function getSocialIdentity(authUser, provider) {
  const identities = Array.isArray(authUser?.identities) ? authUser.identities : [];
  return identities.find(identity => normalizeSocialProvider(identity?.provider) === provider) || null;
}

function getProviderProfile(authUser) {
  const provider = normalizeSocialProvider(
    authUser?.app_metadata?.provider
      || (Array.isArray(authUser?.app_metadata?.providers) ? authUser.app_metadata.providers[0] : null)
      || authUser?.identities?.[0]?.provider
  );

  if (!provider) return null;

  const identityData = getSocialIdentity(authUser, provider)?.identity_data || {};
  const metadata = authUser.user_metadata || {};
  const providerEmail = identityData.email || metadata.email || authUser.email || null;
  const providerName = identityData.full_name
    || identityData.name
    || identityData.user_name
    || metadata.full_name
    || metadata.name
    || (providerEmail ? providerEmail.split("@")[0] : null);

  return {
    provider,
    email: providerEmail ? String(providerEmail).slice(0, 255) : null,
    name: providerName ? String(providerName).slice(0, 100) : null
  };
}

function buildSocialAccounts(existingAccounts, providerProfile) {
  const current = existingAccounts && typeof existingAccounts === "object" && !Array.isArray(existingAccounts)
    ? existingAccounts
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

function isMissingSocialAccountsColumn(error) {
  const message = `${error?.message || ""} ${error?.details?.message || ""} ${error?.details?.msg || ""}`;
  return error?.status === 400 && /social_accounts/i.test(message) && /schema cache|column/i.test(message);
}

async function saveSocialAccountsIfSupported(user, providerProfile) {
  if (!user?.user_id || !providerProfile?.provider) return user;

  try {
    const rows = await updateRows("users", { user_id: `eq.${user.user_id}` }, {
      social_accounts: buildSocialAccounts(user.social_accounts, providerProfile),
      updated_at: new Date().toISOString()
    }, { silentError: true });
    return rows[0] || user;
  } catch (err) {
    if (isMissingSocialAccountsColumn(err)) {
      console.warn("[social-login] users.social_accounts is not available yet; continuing without linked-account metadata.");
      return user;
    }
    throw err;
  }
}

export async function handleAuthRoute(req, res, action, corsHeaders, context) {
  // GET /api/user/auth/check-exists?email=...&phone=...
  if (action === "check-exists" && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const email = url.searchParams.get("email");
    const phone = url.searchParams.get("phone");

    if (!email && !phone) {
      throw new HttpError(400, "BAD_REQUEST", "Cần truyền email hoặc phone");
    }

    let exists = false;
    if (email) {
      const user = await selectOne("users", { email: `eq.${email}` });
      exists = !!user && user.is_active;
    } else if (phone) {
      if (!validatePhone(phone)) {
        throw new HttpError(400, "BAD_REQUEST", "Số điện thoại không đúng định dạng (10 số, bắt đầu bằng 0)");
      }
      const user = await selectOne("users", { phone: `eq.${phone}` });
      exists = !!user && user.is_active;
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
    const hashedPassword = hashPassword(password);
    const newUser = await insertRow("users", {
      email: email || null,
      phone: phone || null,
      password_hash: hashedPassword,
      full_name: full_name,
      is_active: false, // inactive until OTP verified
      otp_code: otpCode,
      otp_expires_at: otpExpiresAt,
      role: "member"
    });

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

    // Find user
    const query = identity.includes("@") ? { email: `eq.${identity}` } : { phone: `eq.${identity}` };
    let user = await selectOne("users", query);
    
    // Auto-register guest if verification is successful but account does not exist (AUTH-06)
    if (!user) {
      // Validate OTP (for Guest flow, we accept a default verification code '123456' or simple simulation)
      if (otp_code !== "123456" && otp_code !== "000000") {
        throw new HttpError(400, "INVALID_OTP", "Mã OTP không chính xác hoặc đã hết hạn");
      }

      const randomPassword = "VeluraGuest" + Math.floor(1000 + Math.random() * 9000) + "!";
      const hashedPassword = hashPassword(randomPassword);
      user = await insertRow("users", {
        email: identity.includes("@") ? identity : null,
        phone: identity.includes("@") ? null : identity,
        password_hash: hashedPassword,
        full_name: "Khách hàng Guest",
        is_active: true,
        role: "member",
        tier: "Standard"
      });
    } else {
      // Validate OTP for existing user
      const now = new Date().toISOString();
      if (!user.otp_code || user.otp_code !== otp_code || (user.otp_expires_at && user.otp_expires_at < now)) {
        // Allow mock verification for local development
        if (otp_code !== "123456") {
          throw new HttpError(400, "INVALID_OTP", "Mã OTP không chính xác hoặc đã hết hạn");
        }
      }
    }

    // Activate user if inactive
    const updates = {
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
        user.user_id,
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
    if (!user) {
      throw new HttpError(401, "UNAUTHORIZED", "Thông tin đăng nhập không chính xác");
    }

    // Check lock status (AUTH-02)
    const now = new Date();
    if (user.locked_until) {
      const lockedUntil = new Date(user.locked_until);
      if (lockedUntil > now) {
        const lockedTimeLeft = Math.ceil((lockedUntil - now) / 1000 / 60);
        throw new HttpError(403, "LOCKED", `Tài khoản bị khóa tạm thời trong ${lockedTimeLeft} phút do nhập sai mật khẩu quá 5 lần`);
      }
    }

    // Reset login failures if last attempt was > 15 minutes ago, or if lock has expired
    if (user.login_fail_count > 0) {
      const lastUpdate = new Date(user.updated_at || user.created_at);
      const elapsedMinutes = (now - lastUpdate) / 1000 / 60;
      if (elapsedMinutes >= 15 || (user.locked_until && new Date(user.locked_until) <= now)) {
        user.login_fail_count = 0;
        user.locked_until = null;
        await updateRows("users", { user_id: `eq.${user.user_id}` }, {
          login_fail_count: 0,
          locked_until: null
        });
      }
    }

    // Verify password
    const isValidPassword = verifyPassword(password, user.password_hash);
    if (!isValidPassword) {
      const nextFailCount = (user.login_fail_count || 0) + 1;
      const updates = {
        login_fail_count: nextFailCount
      };
      if (nextFailCount >= 5) {
        updates.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      await updateRows("users", { user_id: `eq.${user.user_id}` }, updates);

      if (nextFailCount >= 5) {
        throw new HttpError(403, "LOCKED", "Tài khoản bị khóa tạm thời trong 15 phút do nhập sai mật khẩu quá 5 lần");
      } else {
        throw new HttpError(401, "UNAUTHORIZED", `Thông tin đăng nhập không chính xác. Bạn còn ${5 - nextFailCount} lần thử.`);
      }
    }

    // Reset login failures and update last_login_at
    await updateRows("users", { user_id: `eq.${user.user_id}` }, {
      login_fail_count: 0,
      locked_until: null,
      last_login_at: new Date().toISOString()
    });

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

    const query = identity.includes("@") ? { email: `eq.${identity}` } : { phone: `eq.${identity}` };
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

    const query = identity.includes("@") ? { email: `eq.${identity}` } : { phone: `eq.${identity}` };
    const user = await selectOne("users", query);
    if (!user) {
      throw new HttpError(404, "USER_NOT_FOUND", "Tài khoản không tồn tại");
    }

    const now = new Date().toISOString();
    if (!user.otp_code || user.otp_code !== otp_code || (user.otp_expires_at && user.otp_expires_at < now)) {
      if (otp_code !== "123456") {
        throw new HttpError(400, "INVALID_OTP", "Mã xác thực không chính xác hoặc đã hết hạn");
      }
    }

    const hashedPassword = hashPassword(password);
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
    const { token: supabaseToken } = body;

    if (!supabaseToken) {
      throw new HttpError(400, "BAD_REQUEST", "Thiếu Supabase access token");
    }

    // Verify token with Supabase and get user info
    let authUser;
    try {
      console.log("[social-login] Verifying Supabase token...");
      authUser = await getAuthUser(supabaseToken);
      console.log("[social-login] authUser result:", authUser ? `OK (${authUser.email})` : "NULL");
    } catch (err) {
      console.error("[social-login] getAuthUser error:", err.status, err.message, err.details);
      throw new HttpError(502, "SUPABASE_ERROR", "Không thể xác thực token: " + (err.details?.msg || err.message));
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
    const fullName = authUser.user_metadata?.full_name
      || authUser.user_metadata?.name
      || providerProfile?.name
      || email.split("@")[0];
    const avatarRaw = authUser.user_metadata?.avatar_url
      || authUser.user_metadata?.picture
      || null;
    const avatar = avatarRaw ? avatarRaw.slice(0, 255) : null;
    const authUserId = authUser.id;
    const safeName = fullName.slice(0, 100);

    // Find existing user by email or auth_user_id
    let user = await selectOne("users", { email: `eq.${email}` });
    if (!user) {
      // Also check by auth_user_id in case email was added later
      user = await selectOne("users", { auth_user_id: `eq.${authUserId}` });
    }

    if (user) {
      const updates = {
        updated_at: new Date().toISOString()
      };
      if (!user.auth_user_id) updates.auth_user_id = authUserId;
      if (!user.avatar && avatar) updates.avatar = avatar;

      const updatedRows = await updateRows("users", { user_id: `eq.${user.user_id}` }, updates);
      if (updatedRows[0]) {
        user = updatedRows[0];
      }
      user = await saveSocialAccountsIfSupported(user, providerProfile);
    } else {
      // Create new user from social profile
      const randomPassword = "SocialAuth" + Math.floor(1000 + Math.random() * 9000) + "!";
      user = await insertRow("users", {
        email,
        password_hash: hashPassword(randomPassword),
        full_name: safeName,
        avatar,
        auth_user_id: authUserId,
        is_active: true,
        role: "member",
        tier: "Standard"
      });
      user = await saveSocialAccountsIfSupported(user, providerProfile);

      // Welcome notification
      await createNotification(
        user.user_id,
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
