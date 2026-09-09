import { HttpError } from "./http.js";
import { verifyJwt } from "./auth-helper.js";
import { getAuthUser, selectOne } from "./supabase.js";
import type { AuthContext, AuthUser, HttpRequest, JsonObject, UserProfile } from "./types.js";

export const rolePages: Record<string, string[]> = {
  super_admin: ["dashboard", "accounts", "products", "orders", "reviews", "returns-cskh", "pricing", "promotions", "logs"],
  admin_operator_sanpham: ["products", "dashboard"],
  admin_operator_donhang: ["orders", "dashboard"],
  admin_operator_gia_km: ["pricing", "dashboard", "promotions"],
  admin_operator_danhgia_review: ["reviews", "dashboard"],
  admin_operator_cskh_dt: ["returns-cskh", "dashboard"],
  admin_viewer: ["dashboard"],
  member: ["welcome"],
  guest: ["welcome"]
};

export const roleModules: Record<string, string[]> = {
  super_admin: ["*"],
  admin_operator_sanpham: ["dashboard", "products", "categories", "inventory", "audit_logs"],
  admin_operator_donhang: ["dashboard", "orders", "payments", "shipments", "audit_logs"],
  admin_operator_gia_km: ["dashboard", "pricing", "promotions", "vouchers", "bundles", "budgets", "audit_logs"],
  admin_operator_danhgia_review: ["dashboard", "reviews", "support_tickets", "audit_logs"],
  admin_operator_cskh_dt: ["dashboard", "returns", "support_tickets", "orders", "audit_logs"],
  admin_viewer: ["dashboard"],
  member: [],
  guest: []
};

/**
 * Build guest, member, or admin context from the Authorization header.
 */
export async function buildAuthContext(req: HttpRequest): Promise<AuthContext> {
  const token = getToken(req);
  if (!token) return buildGuestContext();

  const accountSelect = [
    "user_id", "auth_user_id", "email", "phone", "full_name", "date_of_birth", "gender", "avatar",
    "role", "admin_role", "is_active", "is_verified", "created_at",
    "last_login_at", "version", "updated_at", "saved_addresses"
  ].join(",");
  const dbOptions = {};

  let authUser: AuthUser | null = null;
  try {
    authUser = await getAuthUser(token);
  } catch {
    // Fall back to local custom JWT
  }

  const decoded = verifyJwt(token);

  if (decoded && !authUser?.id) {
    let profile: UserProfile | null = null;
    try {
      profile = asProfile(await selectOne("users", {
        select: accountSelect,
        user_id: `eq.${String(decoded.user_id ?? "")}`
      }, dbOptions));
    } catch {
      profile = null;
    }

    if (!profile) return buildGuestContext();

    const roleCode = roleCodeOf(profile);
    return {
      authUser: { id: profile.user_id, email: typeof profile.email === "string" ? profile.email : null },
      profile,
      roleCode,
      roleName: roleNames[roleCode] || "Member",
      isAdmin: profile.role === "admin",
      allowedPages: rolePages[roleCode] || rolePages.member,
      accessToken: token
    };
  }

  if (!authUser?.id) return buildGuestContext();

  let profile: UserProfile | null = null;
  try {
    profile = asProfile(await selectOne("users", {
      select: accountSelect,
      auth_user_id: `eq.${authUser.id}`
    }, dbOptions));
    if (!profile) {
      profile = asProfile(await selectOne("users", {
        select: accountSelect,
        email: `eq.${authUser.email || ""}`
      }, dbOptions));
    }
  } catch {
    profile = null;
  }

  if (!profile) {
    return {
      authUser,
      profile: null,
      roleCode: "member",
      roleName: "Member",
      isAdmin: false,
      allowedPages: rolePages.member,
      accessToken: token
    };
  }

  const roleCode = roleCodeOf(profile);
  return {
    authUser,
    profile,
    roleCode,
    roleName: roleNames[roleCode] || "Member",
    isAdmin: profile.role === "admin",
    allowedPages: rolePages[roleCode] || rolePages.member,
    accessToken: token
  };
}

/**
 * Require a signed-in user.
 */
export function requireAuthenticated(context: AuthContext): void {
  if (!context.authUser?.id) {
    throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
  }
}

/**
 * Require an active admin profile.
 */
export function requireAdmin(context: AuthContext): void {
  requireAuthenticated(context);
  if (!context.isAdmin || !context.profile?.is_active) {
    throw new HttpError(403, "ADMIN_REQUIRED", "Admin access is required");
  }
}

/**
 * Require the admin role to access a module and action.
 */
export function requirePermission(context: AuthContext, moduleName: string, action = "read"): void {
  requireAdmin(context);
  const modules = roleModules[context.roleCode] || [];
  const canAccessModule = modules.includes("*") || modules.includes(moduleName);
  const readOnlyBlocked = context.roleCode === "admin_viewer" && action !== "read";

  if (!canAccessModule || readOnlyBlocked) {
    throw new HttpError(403, "RBAC_DENIED", "This admin role cannot perform the requested action", {
      role: context.roleCode,
      module: moduleName,
      action
    });
  }
}

function buildGuestContext(): AuthContext {
  return {
    authUser: null,
    profile: null,
    roleCode: "guest",
    roleName: "Guest",
    isAdmin: false,
    allowedPages: rolePages.guest,
    accessToken: ""
  };
}

function getToken(req: HttpRequest): string {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function asProfile(row: JsonObject | null): UserProfile | null {
  if (!row || typeof row.user_id !== "string") return null;
  return row as UserProfile;
}

function roleCodeOf(profile: UserProfile): string {
  if (profile.role === "admin" && typeof profile.admin_role === "string") {
    return profile.admin_role;
  }
  return typeof profile.role === "string" && profile.role ? profile.role : "member";
}

const roleNames: Record<string, string> = {
  super_admin: "Admin quan tri",
  admin_viewer: "Admin chi xem",
  admin_operator_sanpham: "Admin quan ly san pham",
  admin_operator_donhang: "Admin quan ly don hang",
  admin_operator_cskh_dt: "Admin doi tra va CSKH",
  admin_operator_gia_km: "Admin quan ly gia va khuyen mai",
  admin_operator_danhgia_review: "Admin quan ly danh gia",
  member: "Member",
  guest: "Guest"
};
