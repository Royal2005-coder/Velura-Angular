import { asProfile, AUTH_PROFILE_SELECT, loadProfileForAuthUser } from "./auth-profile.js";
import { verifyJwt } from "./auth-helper.js";
import { HttpError } from "./http.js";
import { getAuthUser, selectOne } from "./supabase.js";
import type { AuthContext, AuthUser, HttpRequest, UserProfile } from "./types.js";

export const rolePages: Record<string, string[]> = {
  super_admin: ["dashboard", "accounts", "products", "orders", "reviews", "returns-cskh", "pricing", "promotions", "content", "members", "logs"],
  admin_operator_sanpham: ["products"],
  admin_operator_donhang: ["orders"],
  admin_operator_gia_km: ["pricing", "promotions"],
  admin_operator_danhgia_review: ["reviews"],
  admin_operator_cskh_dt: ["returns-cskh"],
  admin_viewer: ["dashboard"],
  member: ["welcome"],
  guest: ["welcome"]
};

export const roleModules: Record<string, string[]> = {
  super_admin: ["*"],
  admin_operator_sanpham: ["products", "categories", "inventory", "audit_logs"],
  admin_operator_donhang: ["orders", "payments", "shipments", "audit_logs"],
  admin_operator_gia_km: ["pricing", "promotions", "vouchers", "bundles", "budgets", "audit_logs"],
  admin_operator_danhgia_review: ["reviews", "support_tickets", "audit_logs"],
  admin_operator_cskh_dt: ["returns", "support_tickets", "orders", "audit_logs"],
  admin_viewer: ["dashboard"],
  member: [],
  guest: []
};

export type AdminAction = "read" | "create" | "update" | "delete" | "approve";
export type AdminCapabilities = Record<string, AdminAction[]>;

const ALL_ACTIONS: AdminAction[] = ["read", "create", "update", "delete", "approve"];

/**
 * Write actions granted per module. Read is implied by `roleModules`.
 * Keep this beside the role matrix; the frontend must not re-declare it.
 */
const MODULE_WRITE_ACTIONS: Record<string, AdminAction[]> = {
  products: ["create", "update"],
  categories: ["create", "update"],
  inventory: ["create", "update"],
  orders: ["update"],
  payments: ["update"],
  shipments: ["update"],
  pricing: ["create", "update"],
  promotions: ["create", "update"],
  vouchers: ["create", "update"],
  bundles: ["create", "update"],
  budgets: ["create", "update"],
  reviews: ["update"],
  support_tickets: ["update"],
  returns: ["update"],
  accounts: ["create", "update", "delete", "approve"],
  content: ["create", "update"],
  members: ["update"],
  audit_logs: []
};

const MODULE_WRITE_ROLES: Record<string, string[]> = {
  products: ["super_admin", "admin_operator_sanpham"],
  categories: ["super_admin", "admin_operator_sanpham"],
  inventory: ["super_admin", "admin_operator_sanpham"],
  orders: ["super_admin", "admin_operator_donhang"],
  payments: ["super_admin", "admin_operator_donhang"],
  shipments: ["super_admin", "admin_operator_donhang"],
  pricing: ["super_admin", "admin_operator_gia_km"],
  promotions: ["super_admin", "admin_operator_gia_km"],
  vouchers: ["super_admin", "admin_operator_gia_km"],
  bundles: ["super_admin", "admin_operator_gia_km"],
  budgets: ["super_admin", "admin_operator_gia_km"],
  reviews: ["super_admin", "admin_operator_danhgia_review"],
  support_tickets: ["super_admin", "admin_operator_danhgia_review", "admin_operator_cskh_dt"],
  returns: ["super_admin", "admin_operator_cskh_dt"],
  accounts: ["super_admin"],
  content: ["super_admin"],
  members: ["super_admin"],
  audit_logs: []
};

/**
 * Derives action-level capabilities from the canonical role matrix.
 * Super admins receive the wildcard; every other role can read its modules.
 */
export function capabilitiesForRole(roleCode: string): AdminCapabilities {
  if (roleCode === "super_admin") {
    return { "*": [...ALL_ACTIONS] };
  }
  const modules = roleModules[roleCode] || roleModules.member;
  const capabilities: AdminCapabilities = {};
  for (const moduleName of modules) {
    const actions: AdminAction[] = ["read"];
    if ((MODULE_WRITE_ROLES[moduleName] || []).includes(roleCode)) {
      for (const action of MODULE_WRITE_ACTIONS[moduleName] || ["update" as AdminAction]) {
        if (!actions.includes(action)) actions.push(action);
      }
    }
    capabilities[moduleName] = actions;
  }
  return capabilities;
}

/**
 * Whether a context may perform one action on one module.
 */
export function hasCapability(context: AuthContext, moduleName: string, action: AdminAction): boolean {
  const capabilities = context.capabilities || capabilitiesForRole(context.roleCode);
  const granted = capabilities["*"] || capabilities[moduleName] || [];
  return granted.includes(action);
}

/**
 * Canonical page list + module list + action capabilities for one role code.
 */
export function accessForRole(roleCode: string): {
  allowedPages: string[];
  allowedModules: string[];
  capabilities: AdminCapabilities;
} {
  return {
    allowedPages: rolePages[roleCode] || rolePages.member,
    allowedModules: roleModules[roleCode] || roleModules.member,
    capabilities: capabilitiesForRole(roleCode)
  };
}

/**
 * Build guest, member, or admin context from the Authorization header.
 */
export async function buildAuthContext(req: HttpRequest): Promise<AuthContext> {
  const token = getToken(req);
  if (!token) return buildGuestContext();

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
        select: AUTH_PROFILE_SELECT,
        user_id: `eq.${String(decoded.user_id ?? "")}`
      }));
    } catch {
      profile = null;
    }

    if (!profile) return buildGuestContext();

    const roleCode = roleCodeOf(profile);
    const access = accessForRole(roleCode);
    return {
      authUser: { id: profile.user_id, email: typeof profile.email === "string" ? profile.email : null },
      profile,
      roleCode,
      roleName: roleNames[roleCode] || "Member",
      isAdmin: profile.role === "admin",
      allowedPages: access.allowedPages,
      allowedModules: access.allowedModules,
      capabilities: access.capabilities,
      accessToken: token
    };
  }

  if (!authUser?.id) return buildGuestContext();

  let profile: UserProfile | null = null;
  try {
    profile = await loadProfileForAuthUser(authUser);
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
      allowedModules: roleModules.member,
      capabilities: capabilitiesForRole("member"),
      accessToken: token
    };
  }

  const roleCode = roleCodeOf(profile);
  const access = accessForRole(roleCode);
  return {
    authUser,
    profile,
    roleCode,
    roleName: roleNames[roleCode] || "Member",
    isAdmin: profile.role === "admin",
    allowedPages: access.allowedPages,
    allowedModules: access.allowedModules,
    capabilities: access.capabilities,
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
  const normalized = action === "write" ? "update" : action;
  const modules = roleModules[context.roleCode] || [];
  const canAccessModule = modules.includes("*") || modules.includes(moduleName);
  const allowedAction = (ALL_ACTIONS as string[]).includes(normalized) && hasCapability(context, moduleName, normalized as AdminAction);
  const readOnlyBlocked = context.roleCode === "admin_viewer" && normalized !== "read";

  if (!canAccessModule || !allowedAction || readOnlyBlocked) {
    throw new HttpError(403, "RBAC_DENIED", "This admin role cannot perform the requested action", {
      role: context.roleCode,
      module: moduleName,
      action: normalized
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
    allowedModules: roleModules.guest,
    capabilities: capabilitiesForRole("guest"),
    accessToken: ""
  };
}

function getToken(req: HttpRequest): string {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
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
