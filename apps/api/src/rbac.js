import { HttpError } from "./http.js";
import { verifyJwt } from "./auth-helper.js";
import { getAuthUser, selectOne } from "./supabase.js";

export const rolePages = {
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

export const roleModules = {
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

export async function buildAuthContext(req) {
  const token = getToken(req);
  if (!token) return buildGuestContext();

  const accountSelect = [
    "user_id", "auth_user_id", "email", "phone", "full_name", "date_of_birth", "gender", "avatar",
    "role", "admin_role", "is_active", "is_verified", "created_at",
    "last_login_at", "version", "updated_at", "saved_addresses"
  ].join(",");
  const dbOptions = {};

  // Try Supabase Auth first
  let authUser = null;
  try {
    authUser = await getAuthUser(token);
  } catch (err) {
    // Ignore error and fall back to local custom JWT
  }

  const decoded = verifyJwt(token);

  if (decoded && !authUser?.id) {
    let profile = null;
    try {
      profile = await selectOne("users", {
        select: accountSelect,
        user_id: `eq.${decoded.user_id}`
      }, dbOptions);
    } catch {
      profile = null;
    }

    if (!profile) return buildGuestContext();

    const roleCode = profile.role === "admin" ? profile.admin_role : profile.role || "member";
    return {
      authUser: { id: profile.user_id, email: profile.email },
      profile,
      roleCode,
      roleName: roleNames[roleCode] || "Member",
      isAdmin: profile.role === "admin",
      allowedPages: rolePages[roleCode] || rolePages.member,
      accessToken: token
    };
  }

  if (!authUser?.id) return buildGuestContext();

  let profile = null;
  try {
    profile = await selectOne("users", {
      select: accountSelect,
      auth_user_id: `eq.${authUser.id}`
    }, dbOptions);
    if (!profile) {
      profile = await selectOne("users", {
        select: accountSelect,
        email: `eq.${authUser.email}`
      }, dbOptions);
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

  const roleCode = profile.role === "admin" ? profile.admin_role : profile.role || "member";
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

export function requireAuthenticated(context) {
  if (!context.authUser?.id) {
    throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
  }
}

export function requireAdmin(context) {
  requireAuthenticated(context);
  if (!context.isAdmin || !context.profile?.is_active) {
    throw new HttpError(403, "ADMIN_REQUIRED", "Admin access is required");
  }
}

export function requirePermission(context, moduleName, action = "read") {
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

function buildGuestContext() {
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

function getToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

const roleNames = {
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
