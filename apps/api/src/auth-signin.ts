import { config } from "./config.js";
import { getRequestIp, HttpError } from "./http.js";
import { insertRow } from "./supabase.js";
import { asString, type AuthContext, type HttpRequest, type JsonObject } from "./types.js";
import {
  assertNotLocked,
  clearLoginFailures,
  findUserByEmail,
  recordFailedLogin,
  resetStaleLoginFailures
} from "./auth-lockout.js";

/**
 * Admin password grant: lockout on public.users, then Supabase Auth.
 */
export async function completeAdminPasswordSignIn(body: JsonObject): Promise<{ token: string }> {
  const email = asString(body.email).trim();
  const password = asString(body.password);
  if (!email || !password) {
    throw new HttpError(400, "BAD_REQUEST", "Email và mật khẩu là bắt buộc");
  }

  const found = await findUserByEmail(email);
  const user = found ? await resetStaleLoginFailures(found) : null;
  if (user) {
    assertNotLocked(user);
  }

  const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ email, password })
  });
  const payload = (await response.json().catch(() => ({}))) as JsonObject;
  if (!response.ok || !payload.access_token) {
    if (user) {
      await recordFailedLogin(user);
    }
    throw new HttpError(
      401,
      "UNAUTHORIZED",
      asString(payload.error_description) || asString(payload.msg) || "Thông tin đăng nhập không chính xác."
    );
  }

  if (user) {
    await clearLoginFailures(user.user_id);
  }
  return { token: asString(payload.access_token) };
}

/**
 * Best-effort AUTH-08 audit row. Client still clears the session if this insert fails.
 */
export async function recordAdminSignOut(req: HttpRequest, context: AuthContext): Promise<void> {
  try {
    await insertRow("audit_log", {
      actor_id: context.profile?.user_id || context.authUser?.id || null,
      actor_role: context.roleCode,
      action: "signout",
      module: "auth",
      target_id: context.profile?.user_id || context.authUser?.id || null,
      old_value: { session: "active" },
      new_value: { session: "cleared" },
      ip_address: getRequestIp(req),
      timestamp: new Date().toISOString()
    }, { silentError: true, accessToken: context.accessToken, useAnonKey: true });
  } catch {
    // AUTH-08 still succeeds for the client if audit insert is denied.
  }
}
