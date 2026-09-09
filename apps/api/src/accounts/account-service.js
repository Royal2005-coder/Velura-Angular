import { HttpError } from "../http.js";
import { ACCOUNT_ROLES, ADMIN_ROLES, ROLE_OPTIONS } from "./account-constants.js";

export function createAccountService({ repository }) {
  if (!repository) throw new TypeError("repository is required");

  return {
    roles(context) {
      requireAccountAdmin(context);
      return ROLE_OPTIONS;
    },

    async list(context, searchParams) {
      requireAccountAdmin(context);
      return repository.list(parseListFilters(searchParams), context.accessToken);
    },

    async get(context, userId) {
      requireAccountAdmin(context);
      requireUuid(userId, "userId");
      const account = await repository.findById(userId, context.accessToken);
      if (!account) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "Account was not found");
      return account;
    },

    async listRoleRequests(context, searchParams) {
      requireAccountAdmin(context);
      return repository.listRoleRequests(parseRequestFilters(searchParams), context.accessToken);
    },

    async listAuditLogs(context, searchParams) {
      requireAccountAdmin(context);
      const targetId = searchParams.get("targetId") || "";
      if (targetId) requireUuid(targetId, "targetId");
      return repository.listAuditLogs({
        targetId: targetId || undefined,
        limit: clampInteger(searchParams.get("limit"), 50, 1, 100),
        offset: clampInteger(searchParams.get("offset"), 0, 0, 1000000)
      }, context.accessToken);
    },

    async lock(context, userId, body, requestMeta) {
      requireAccountAdmin(context);
      requireUuid(userId, "userId");
      const input = validateLock(body, requestMeta);
      return repository.lock(userId, input, context.profile.user_id, context.accessToken);
    },

    async unlock(context, userId, body, requestMeta) {
      requireAccountAdmin(context);
      requireUuid(userId, "userId");
      const input = validateUnlock(body, requestMeta);
      return repository.unlock(userId, input, context.profile.user_id, context.accessToken);
    },

    async changeRole(context, userId, body, requestMeta) {
      requireAccountAdmin(context);
      requireUuid(userId, "userId");
      const input = validateRoleChange(body, requestMeta);
      return repository.changeRole(userId, input, context.profile.user_id, context.accessToken);
    },

    async reviewRoleRequest(context, requestId, decision, body, requestMeta) {
      requireAccountAdmin(context);
      requireUuid(requestId, "requestId");
      if (!["approve", "reject"].includes(decision)) {
        throw validationError("decision", "Decision must be approve or reject");
      }
      const input = {
        decision,
        expectedVersion: requireVersion(body?.expectedVersion),
        note: optionalText(body?.note, 1000),
        ipAddress: requestMeta.ipAddress
      };
      if (decision === "reject") requireReason(input.note, "note");
      return repository.reviewRoleRequest(requestId, input, context.accessToken);
    }
  };
}

export function validateLock(body = {}, requestMeta = {}) {
  if (!["temporary", "permanent"].includes(body.lockType)) {
    throw validationError("lockType", "lockType must be temporary or permanent");
  }
  const lockedUntil = body.lockedUntil ? parseFutureDate(body.lockedUntil, "lockedUntil") : null;
  if (body.lockType === "permanent" && lockedUntil) {
    throw validationError("lockedUntil", "Permanent locks cannot have an expiry");
  }
  return {
    lockType: body.lockType,
    reason: requireReason(body.reason),
    expectedVersion: requireVersion(body.expectedVersion),
    lockedUntil,
    ipAddress: requestMeta.ipAddress || "0.0.0.0"
  };
}

export function validateUnlock(body = {}, requestMeta = {}) {
  return {
    reason: requireReason(body.reason),
    expectedVersion: requireVersion(body.expectedVersion),
    ipAddress: requestMeta.ipAddress || "0.0.0.0"
  };
}

export function validateRoleChange(body = {}, requestMeta = {}) {
  if (!ACCOUNT_ROLES.includes(body.role)) {
    throw validationError("role", "role must be member or admin");
  }
  const adminRole = body.adminRole ?? null;
  if (body.role === "admin" && !ADMIN_ROLES.includes(adminRole)) {
    throw validationError("adminRole", "A valid adminRole is required for admin accounts");
  }
  if (body.role === "member" && adminRole !== null) {
    throw validationError("adminRole", "adminRole must be null for members");
  }
  return {
    role: body.role,
    adminRole,
    expectedVersion: requireVersion(body.expectedVersion),
    ipAddress: requestMeta.ipAddress || "0.0.0.0"
  };
}

export function countWords(value) {
  const text = String(value || "").trim();
  return text ? text.split(/\s+/u).filter(Boolean).length : 0;
}

function requireAccountAdmin(context) {
  if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
  if (!context.isAdmin || !context.profile?.is_active || context.roleCode !== "super_admin") {
    throw new HttpError(403, "RBAC_DENIED", "Only an active super admin can manage accounts");
  }
}

function parseListFilters(searchParams) {
  const role = searchParams.get("role") || "";
  const adminRole = searchParams.get("adminRole") || "";
  const active = searchParams.get("isActive");
  if (role && !ACCOUNT_ROLES.includes(role)) throw validationError("role", "Invalid role filter");
  if (adminRole && !ADMIN_ROLES.includes(adminRole)) throw validationError("adminRole", "Invalid adminRole filter");
  if (active !== null && !["true", "false"].includes(active)) throw validationError("isActive", "isActive must be true or false");
  const orderInput = searchParams.get("order") || "created_at.desc";
  const allowedOrders = ["created_at.desc", "created_at.asc", "full_name.asc", "full_name.desc", "last_login_at.desc"];
  return {
    q: String(searchParams.get("q") || "").trim().slice(0, 100),
    role: role || undefined,
    adminRole: adminRole || undefined,
    isActive: active === null ? undefined : active === "true",
    limit: clampInteger(searchParams.get("limit"), 20, 1, 100),
    offset: clampInteger(searchParams.get("offset"), 0, 0, 1000000),
    order: allowedOrders.includes(orderInput) ? orderInput : "created_at.desc"
  };
}

function parseRequestFilters(searchParams) {
  const status = searchParams.get("status") || "";
  if (status && !["pending", "approved", "rejected", "expired"].includes(status)) {
    throw validationError("status", "Invalid approval status");
  }
  return {
    status: status || undefined,
    limit: clampInteger(searchParams.get("limit"), 20, 1, 100),
    offset: clampInteger(searchParams.get("offset"), 0, 0, 1000000)
  };
}

function requireReason(value, field = "reason") {
  const reason = String(value || "").trim().replace(/\s+/g, " ");
  if (countWords(reason) <= 10) {
    throw validationError(field, `${field} must contain more than 10 words`);
  }
  if (reason.length > 1000) throw validationError(field, `${field} must be at most 1000 characters`);
  return reason;
}

function requireVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw validationError("expectedVersion", "expectedVersion must be a positive integer");
  }
  return version;
}

function optionalText(value, maxLength) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (text.length > maxLength) throw validationError("note", `note must be at most ${maxLength} characters`);
  return text;
}

function parseFutureDate(value, field) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date <= new Date()) {
    throw validationError(field, `${field} must be a future ISO date`);
  }
  return date.toISOString();
}

function requireUuid(value, field) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""))) {
    throw validationError(field, `${field} must be a UUID`);
  }
}

function clampInteger(raw, fallback, min, max) {
  if (raw === null || raw === "") return fallback;
  const number = Number(raw);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function validationError(field, message) {
  return new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { [field]: [message] });
}
