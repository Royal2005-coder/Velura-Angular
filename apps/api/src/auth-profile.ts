import { selectOne, selectRows, updateRows } from "./supabase.js";
import type { AuthUser, JsonObject, UserProfile } from "./types.js";

export const AUTH_PROFILE_SELECT = [
  "user_id",
  "auth_user_id",
  "email",
  "phone",
  "full_name",
  "date_of_birth",
  "gender",
  "avatar",
  "role",
  "admin_role",
  "is_active",
  "is_verified",
  "created_at",
  "last_login_at",
  "version",
  "updated_at",
  "saved_addresses"
].join(",");

/**
 * True when GoTrue rejected the password grant because the mailbox is unconfirmed.
 */
export function isEmailUnconfirmed(payload: JsonObject): boolean {
  const code = `${payload.error_code || payload.error || ""}`.toLowerCase();
  const message = `${payload.error_description || payload.msg || payload.message || ""}`.toLowerCase();
  return code.includes("email_not_confirmed") || message.includes("email not confirmed");
}

/**
 * Prefers the granted admin row when Google/password Auth created a duplicate member profile.
 */
export function preferLinkedProfile(
  byAuth: UserProfile | null,
  byEmail: UserProfile | null
): UserProfile | null {
  if (byAuth && byEmail && byAuth.user_id !== byEmail.user_id) {
    const emailIsAdmin = byEmail.role === "admin";
    const authIsAdmin = byAuth.role === "admin";
    if (emailIsAdmin && !authIsAdmin) return byEmail;
    if (authIsAdmin && !emailIsAdmin) return byAuth;
    return byAuth;
  }
  return byAuth || byEmail;
}

/**
 * Loads public.users for a GoTrue user, attaching Auth to the admin row when duplicates exist.
 */
export async function loadProfileForAuthUser(authUser: AuthUser): Promise<UserProfile | null> {
  const byAuth = asProfile(
    await selectOne("users", {
      select: AUTH_PROFILE_SELECT,
      auth_user_id: `eq.${authUser.id}`
    })
  );
  const byEmail = authUser.email ? await loadProfileByEmail(authUser.email) : null;
  const preferred = preferLinkedProfile(byAuth, byEmail);
  if (!preferred) return null;
  await attachAuthUser(preferred, authUser, byAuth);
  return {
    ...preferred,
    auth_user_id: authUser.id,
    is_verified: true
  };
}

/**
 * Maps a users row onto the RBAC profile shape.
 */
export function asProfile(row: JsonObject | null): UserProfile | null {
  if (!row || typeof row.user_id !== "string") return null;
  return row as UserProfile;
}

async function loadProfileByEmail(email: string): Promise<UserProfile | null> {
  const safe = sanitizeIlike(email);
  if (!safe) return null;
  const { rows } = await selectRows("users", {
    select: AUTH_PROFILE_SELECT,
    email: `ilike.${safe}`,
    limit: 10
  });
  const profiles = rows.map((row) => asProfile(row)).filter((row): row is UserProfile => Boolean(row));
  return profiles.find((row) => row.role === "admin") || profiles[0] || null;
}

async function attachAuthUser(
  preferred: UserProfile,
  authUser: AuthUser,
  currentlyLinked: UserProfile | null
): Promise<void> {
  if (preferred.auth_user_id === authUser.id && preferred.is_verified) {
    return;
  }
  if (currentlyLinked && currentlyLinked.user_id !== preferred.user_id) {
    await updateRows(
      "users",
      { user_id: `eq.${currentlyLinked.user_id}` },
      { auth_user_id: null },
      { silentError: true }
    );
  }
  await updateRows(
    "users",
    { user_id: `eq.${preferred.user_id}` },
    { auth_user_id: authUser.id, is_verified: true },
    { silentError: true }
  );
}

function sanitizeIlike(value: string): string {
  return value.replace(/[*(),]/g, " ").replace(/\s+/g, " ").trim().slice(0, 320);
}
