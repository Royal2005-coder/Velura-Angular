import { config } from "./config.js";
import { isEmailUnconfirmed } from "./auth-profile.js";
import { getRequestIp, HttpError } from "./http.js";
import { writeAuditLog, type AuditLogRow } from "./audit.js";
import { asString, errorMessage, type AuthContext, type HttpRequest, type JsonObject } from "./types.js";
import {
  assertNotLocked,
  clearLoginFailures,
  findUserByEmail,
  recordFailedLogin,
  resetStaleLoginFailures,
  type LoginLockUser
} from "./auth-lockout.js";

/**
 * Best-effort auth audit: authentication still completes when audit_log is unavailable.
 */
async function writeAuthAudit(row: AuditLogRow): Promise<void> {
  try {
    await writeAuditLog(row);
  } catch (error) {
    console.error("[audit] auth write failed", errorMessage(error));
  }
}

function authRole(user: LoginLockUser | null): string {
  return asString(user?.admin_role) || asString(user?.role) || (user ? "member" : "anonymous");
}

/**
 * Best-effort revocation of the Supabase refresh session on sign-out. Access JWTs remain
 * valid until their short expiry; the browser drops its tab-local token immediately.
 */
export async function revokeAdminSession(accessToken: string): Promise<void> {
  if (!accessToken || !config.supabaseUrl) return;
  try {
    await fetch(`${config.supabaseUrl}/auth/v1/logout`, {
      method: "POST",
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${accessToken}`
      },
      signal: AbortSignal.timeout(5_000)
    });
  } catch {
    // Local logout is authoritative for this tab; a failed upstream revoke must not block it.
  }
}

/**
 * Admin password grant: lockout on public.users, then Supabase Auth.
 */
export async function completeAdminPasswordSignIn(body: JsonObject, ipAddress?: string): Promise<{ token: string }> {
  const email = asString(body.email).trim();
  const password = asString(body.password);
  if (!email || !password) {
    throw new HttpError(400, "BAD_REQUEST", "Email và mật khẩu là bắt buộc");
  }

  const found = await findUserByEmail(email);
  const user = found ? await resetStaleLoginFailures(found) : null;
  if (user) {
    try {
      assertNotLocked(user);
    } catch (error) {
      await writeAuthAudit({
        actor_id: asString(user.user_id) || null,
        actor_role: authRole(user),
        action: "signin_blocked",
        module: "auth",
        target_id: asString(user.user_id) || null,
        new_value: { email, reason: "account_locked" },
        ip_address: ipAddress || null
      });
      throw error;
    }
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
    const blocked = isEmailUnconfirmed(payload);
    await writeAuthAudit({
      actor_id: user ? asString(user.user_id) || null : null,
      actor_role: authRole(user),
      action: blocked ? "signin_blocked" : "signin_failed",
      module: "auth",
      target_id: user ? asString(user.user_id) || null : null,
      new_value: { email, reason: blocked ? "email_not_confirmed" : "invalid_credentials" },
      ip_address: ipAddress || null
    });
    if (blocked) {
      throw new HttpError(
        401,
        "EMAIL_NOT_CONFIRMED",
        "Email chưa được xác nhận. Mở thư xác minh hoặc đăng nhập bằng Google."
      );
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
  await writeAuthAudit({
    actor_id: user ? asString(user.user_id) || null : null,
    actor_role: authRole(user),
    action: "signin",
    module: "auth",
    target_id: user ? asString(user.user_id) || null : null,
    new_value: { email },
    ip_address: ipAddress || null
  });
  return { token: asString(payload.access_token) };
}

/**
 * Best-effort sign-out audit; the client still clears its session if the insert fails.
 */
export async function recordAdminSignOut(req: HttpRequest, context: AuthContext): Promise<void> {
  const userId = context.profile?.user_id || context.authUser?.id || null;
  await writeAuthAudit({
    actor_id: userId,
    actor_role: context.roleCode || "system",
    action: "signout",
    module: "auth",
    target_id: userId,
    old_value: { session: "active" },
    new_value: { session: "cleared" },
    ip_address: getRequestIp(req)
  });
}
