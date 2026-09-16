import { HttpError } from "./http.js";
import { selectOne, updateRows } from "./supabase.js";
import type { JsonObject } from "./types.js";

export const LOGIN_ATTEMPT_LIMIT = 5;
export const LOGIN_LOCK_MINUTES = 15;

const LOCKED_MESSAGE = "Tài khoản của bạn đã bị tạm khóa trong 15 phút do nhập sai quá nhiều lần.";

/**
 * Public.users fields used by brute-force lockout.
 */
export interface LoginLockUser {
  user_id: string;
  login_fail_count?: unknown;
  locked_until?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
}

/**
 * API error details the admin login ViewModel binds for remaining tries and countdown.
 */
export interface LoginLockDetails {
  remaining_attempts: number;
  locked_until: string | null;
  retry_after_seconds: number;
}

/**
 * Loads a public.users row by email for lockout bookkeeping. Missing rows stay unlocked.
 */
export async function findUserByEmail(email: string): Promise<LoginLockUser | null> {
  const row = await selectOne("users", {
    select: "user_id,email,login_fail_count,locked_until,updated_at,created_at",
    email: `eq.${email}`
  });
  if (!row || typeof row.user_id !== "string") {
    return null;
  }
  return row as unknown as LoginLockUser;
}

/**
 * Computes remaining tries and lock expiry from a users row.
 */
export function loginLockStatus(user: LoginLockUser, now = new Date()): LoginLockDetails & { isLocked: boolean } {
  const lockedUntil = parseDate(user.locked_until);
  if (lockedUntil && lockedUntil > now) {
    return {
      isLocked: true,
      remaining_attempts: 0,
      locked_until: lockedUntil.toISOString(),
      retry_after_seconds: Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000))
    };
  }
  const failCount = Number(user.login_fail_count) || 0;
  return {
    isLocked: false,
    remaining_attempts: Math.max(0, LOGIN_ATTEMPT_LIMIT - failCount),
    locked_until: null,
    retry_after_seconds: 0
  };
}

/**
 * Next fail-count state after one incorrect password.
 */
export function nextFailedLoginState(failCount: number, now = new Date()): LoginLockDetails & { login_fail_count: number } {
  const nextFailCount = failCount + 1;
  const isLocked = nextFailCount >= LOGIN_ATTEMPT_LIMIT;
  const lockedUntil = isLocked ? new Date(now.getTime() + LOGIN_LOCK_MINUTES * 60 * 1000).toISOString() : null;
  return {
    login_fail_count: nextFailCount,
    remaining_attempts: Math.max(0, LOGIN_ATTEMPT_LIMIT - nextFailCount),
    locked_until: lockedUntil,
    retry_after_seconds: isLocked ? LOGIN_LOCK_MINUTES * 60 : 0
  };
}

/**
 * Rejects sign-in when the account is inside the 15-minute lock window.
 */
export function assertNotLocked(user: LoginLockUser, now = new Date()): void {
  const status = loginLockStatus(user, now);
  if (status.isLocked) {
    throw lockedError(status);
  }
}

/**
 * Clears stale fail counts after 15 minutes or after lock expiry.
 */
export async function resetStaleLoginFailures(user: LoginLockUser, now = new Date()): Promise<LoginLockUser> {
  const failCount = Number(user.login_fail_count) || 0;
  if (failCount <= 0 && !user.locked_until) {
    return user;
  }
  const lockedUntil = parseDate(user.locked_until);
  if (lockedUntil && lockedUntil > now) {
    return user;
  }
  const lastUpdate = parseDate(user.updated_at) || parseDate(user.created_at);
  const elapsedMinutes = lastUpdate ? (now.getTime() - lastUpdate.getTime()) / 1000 / 60 : LOGIN_LOCK_MINUTES;
  if (elapsedMinutes < LOGIN_LOCK_MINUTES && !lockedUntil) {
    return user;
  }
  await updateRows("users", { user_id: `eq.${user.user_id}` }, {
    login_fail_count: 0,
    locked_until: null
  });
  return { ...user, login_fail_count: 0, locked_until: null };
}

/**
 * Increments fail count and throws the UAT AUTH-02 error envelope.
 */
export async function recordFailedLogin(user: LoginLockUser, now = new Date()): Promise<never> {
  const next = nextFailedLoginState(Number(user.login_fail_count) || 0, now);
  const updates: JsonObject = { login_fail_count: next.login_fail_count };
  if (next.locked_until) {
    updates.locked_until = next.locked_until;
  }
  await updateRows("users", { user_id: `eq.${user.user_id}` }, updates);
  if (next.locked_until) {
    throw lockedError(next);
  }
  throw new HttpError(
    401,
    "UNAUTHORIZED",
    `Thông tin đăng nhập không chính xác. Bạn còn ${next.remaining_attempts} lần thử.`,
    {
      remaining_attempts: next.remaining_attempts,
      locked_until: null,
      retry_after_seconds: 0
    }
  );
}

/**
 * Clears fail count after a successful password grant.
 */
export async function clearLoginFailures(userId: string): Promise<void> {
  await updateRows("users", { user_id: `eq.${userId}` }, {
    login_fail_count: 0,
    locked_until: null,
    last_login_at: new Date().toISOString()
  });
}

function lockedError(details: LoginLockDetails): HttpError {
  return new HttpError(403, "LOCKED", LOCKED_MESSAGE, {
    remaining_attempts: 0,
    locked_until: details.locked_until,
    retry_after_seconds: details.retry_after_seconds
  });
}

function parseDate(value: unknown): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
