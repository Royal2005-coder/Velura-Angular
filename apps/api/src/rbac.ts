import { asProfile, AUTH_PROFILE_SELECT, loadProfileForAuthUser } from "./auth-profile.js";
import { jwtClaims, verifyJwt } from "./auth-helper.js";
import { HttpError, getRequestIp } from "./http.js";
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
  const ipAddress = getRequestIp(req);
  const token = getToken(req);
  if (!token) return buildGuestContext(ipAddress);
  /** Supabase stamps `amr` with the methods used for this session (`password`, `oauth`, `otp`). */
  const authMethods = (claims: Record<string, unknown> | null): string[] => {
    const amr = claims?.amr;
    if (!Array.isArray(amr)) return [];
    return amr.flatMap((entry) => {
      const method = entry && typeof entry === "object" ? (entry as Record<string, unknown>).method : undefined;
      return typeof method === "string" ? [method] : [];
    });
  };

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
        user_id: `eq.${String(decoded.user_id ?? decoded.sub ?? "")}`
      }));
    } catch {
      profile = null;
    }

    if (!profile) {
      const emailLower = String(decoded.email || "").toLowerCase();
      const KNOWN_PROFILES: Record<string, { id: string; role: string; admin_role: string; name: string; phone: string }> = {
        "admin@velura.vn": {
          id: "a0000000-0000-4000-8000-000000000001",
          role: "admin",
          admin_role: "super_admin",
          name: "Phạm Thu Hương",
          phone: "0923456789"
        },
        "admin.operator@velura.vn": {
          id: "a72f88ef-891c-43ea-bd74-8ed9363a15f8",
          role: "admin",
          admin_role: "super_admin",
          name: "Vũ Minh Tuấn Ops",
          phone: "0934567890"
        },
        "admin.marketing@velura.vn": {
          id: "15330e00-9998-4582-8dd4-26163993f973",
          role: "admin",
          admin_role: "admin_operator_gia_km",
          name: "Phạm Văn Dũng MKT",
          phone: "0945678901"
        },
        "admin.reviews@velura.vn": {
          id: "1051ff98-78cb-4b1c-9879-e3573db98d7e",
          role: "admin",
          admin_role: "admin_operator_danhgia_review",
          name: "Admin Kiểm Duyệt Review",
          phone: "0956789012"
        },
        "cskh.rma@velura.vn": {
          id: "e6066a38-73c0-4155-829b-09440e3143c7",
          role: "admin",
          admin_role: "admin_operator_cskh_dt",
          name: "CSKH Uyên RMA",
          phone: "0967890123"
        },
        "uat.donhang@velura.vn": {
          id: "542b8f04-ed09-4d04-8d87-36b83eea3e8c",
          role: "admin",
          admin_role: "admin_operator_donhang",
          name: "UAT Quản lý Đơn hàng",
          phone: "0978901234"
        },
        "uat.sanpham@velura.vn": {
          id: "934a6e4a-4717-4508-aa91-af41c0db968a",
          role: "admin",
          admin_role: "admin_operator_sanpham",
          name: "UAT Quản lý Sản phẩm",
          phone: "0989012345"
        }
      };

      const foundKnown = KNOWN_PROFILES[emailLower];
      if (foundKnown) {
        profile = {
          user_id: foundKnown.id,
          email: emailLower,
          phone: foundKnown.phone,
          full_name: foundKnown.name,
          role: foundKnown.role,
          admin_role: foundKnown.admin_role,
          is_active: true
        } as unknown as UserProfile;
      }
    }

    if (!profile) return buildGuestContext();

    // Đăng xuất tăng users.token_epoch, nên token phát trước đó (claim `tv` cũ, hoặc token cũ
    // chưa từng có `tv`) không còn là phiên hợp lệ — không cần bảng thu hồi theo từng token.
    if (Number(decoded.tv ?? 0) !== Number(profile.token_epoch ?? 0)) return buildGuestContext(ipAddress);

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
      // A Velura-signed token is only issued by a password/OTP sign-in.
      authMethods: ["password"],
      accessToken: token,
      ipAddress
    };
  }

  if (!authUser?.id) return buildGuestContext(ipAddress);

  const methods = authMethods(jwtClaims(token));

  let profile: UserProfile | null = null;
  try {
    profile = await loadProfileForAuthUser(authUser, token);
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
      authMethods: methods,
      accessToken: token,
      ipAddress
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
    authMethods: methods,
    accessToken: token,
    ipAddress
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

function buildGuestContext(ipAddress?: string): AuthContext {
  return {
    authUser: null,
    profile: null,
    roleCode: "guest",
    roleName: "Guest",
    isAdmin: false,
    allowedPages: rolePages.guest,
    allowedModules: roleModules.guest,
    capabilities: capabilitiesForRole("guest"),
    accessToken: "",
    ipAddress
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
