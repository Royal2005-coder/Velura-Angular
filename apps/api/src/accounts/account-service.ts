import { randomInt } from "node:crypto";
import { ACCOUNT_AUDIT, enrichAuditLogs } from "../audit-enrichment.js";
import { HttpError } from "../http.js";
import type { AuthContext, AuthUser, JsonObject, RequestMeta, UserProfile } from "../types.js";
import { validateEmail, validatePassword, validatePhone } from "../user/auth.js";
import { ACCOUNT_ROLES, ADMIN_ROLES, ROLE_OPTIONS, type AccountRoleOption } from "./account-constants.js";
import type {
  AccountCreateInput,
  AccountListFilters,
  AccountLockInput,
  AccountRepository,
  AccountRequestFilters,
  AccountReviewInput,
  AccountRoleChangeInput,
  AccountUnlockInput
} from "./account-repository.js";

/**
 * Account methods the admin account router calls.
 */
export interface AccountService {
  roles(context: AuthContext | undefined): AccountRoleOption[];
  list(
    context: AuthContext | undefined,
    searchParams: URLSearchParams
  ): Promise<{ rows: JsonObject[]; count: number | undefined }>;
  get(context: AuthContext | undefined, userId: string): Promise<JsonObject>;
  create(
    context: AuthContext | undefined,
    body: JsonObject,
    requestMeta: RequestMeta
  ): Promise<JsonObject>;
  listRoleRequests(
    context: AuthContext | undefined,
    searchParams: URLSearchParams
  ): Promise<{ rows: JsonObject[]; count: number | undefined }>;
  listAuditLogs(
    context: AuthContext | undefined,
    searchParams: URLSearchParams
  ): Promise<{ rows: JsonObject[]; count: number | undefined }>;
  lock(
    context: AuthContext | undefined,
    userId: string,
    body: JsonObject,
    requestMeta: RequestMeta
  ): Promise<unknown>;
  unlock(
    context: AuthContext | undefined,
    userId: string,
    body: JsonObject,
    requestMeta: RequestMeta
  ): Promise<unknown>;
  changeRole(
    context: AuthContext | undefined,
    userId: string,
    body: JsonObject,
    requestMeta: RequestMeta
  ): Promise<unknown>;
  reviewRoleRequest(
    context: AuthContext | undefined,
    requestId: string,
    decision: string,
    body: JsonObject,
    requestMeta: RequestMeta
  ): Promise<unknown>;
}

/**
 * Super-admin account use cases over an account repository.
 */
export function createAccountService({ repository }: { repository: AccountRepository }): AccountService {
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

    async create(context, body, requestMeta) {
      requireAccountAdmin(context);
      const { input, generatedPassword } = validateCreate(body, requestMeta);
      const created = await repository.create(input, context.profile.user_id, context.roleCode || "super_admin");
      return generatedPassword ? { ...created, temporary_password: generatedPassword } : created;
    },

    async listRoleRequests(context, searchParams) {
      requireAccountAdmin(context);
      return repository.listRoleRequests(parseRequestFilters(searchParams), context.accessToken);
    },

    async listAuditLogs(context, searchParams) {
      requireAccountAdmin(context);
      const targetId = searchParams.get("targetId") || "";
      if (targetId) requireUuid(targetId, "targetId");
      const payload = await repository.listAuditLogs({
        targetId: targetId || undefined,
        limit: clampInteger(searchParams.get("limit"), 50, 1, 100),
        offset: clampInteger(searchParams.get("offset"), 0, 0, 1000000)
      }, context.accessToken);
      return enrichAuditLogs(payload, ACCOUNT_AUDIT);
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
      const input: AccountReviewInput = {
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

/**
 * Validate a lock mutation body.
 */
export function validateLock(body: JsonObject = {}, requestMeta: Partial<RequestMeta> = {}): AccountLockInput {
  const lockType = typeof body.lockType === "string" ? body.lockType : "";
  if (!["temporary", "permanent"].includes(lockType)) {
    throw validationError("lockType", "lockType must be temporary or permanent");
  }
  const lockedUntil = body.lockedUntil ? parseFutureDate(body.lockedUntil, "lockedUntil") : null;
  if (lockType === "permanent" && lockedUntil) {
    throw validationError("lockedUntil", "Permanent locks cannot have an expiry");
  }
  return {
    lockType,
    reason: requireReason(body.reason),
    expectedVersion: requireVersion(body.expectedVersion),
    lockedUntil,
    ipAddress: requestMeta.ipAddress || "0.0.0.0"
  };
}

/**
 * Validate an unlock mutation body.
 */
export function validateUnlock(body: JsonObject = {}, requestMeta: Partial<RequestMeta> = {}): AccountUnlockInput {
  return {
    reason: requireReason(body.reason),
    expectedVersion: requireVersion(body.expectedVersion),
    ipAddress: requestMeta.ipAddress || "0.0.0.0"
  };
}

/**
 * Validate a role-change mutation body against the BA role matrix.
 */
export function validateRoleChange(body: JsonObject = {}, requestMeta: Partial<RequestMeta> = {}): AccountRoleChangeInput {
  const role = typeof body.role === "string" ? body.role : "";
  if (!ACCOUNT_ROLES.includes(role)) {
    throw validationError("role", "role must be member or admin");
  }
  const adminRole = body.adminRole ?? null;
  if (role === "admin" && (typeof adminRole !== "string" || !ADMIN_ROLES.includes(adminRole))) {
    throw validationError("adminRole", "A valid adminRole is required for admin accounts");
  }
  if (role === "member" && adminRole !== null) {
    throw validationError("adminRole", "adminRole must be null for members");
  }
  return {
    role,
    adminRole: typeof adminRole === "string" ? adminRole : null,
    expectedVersion: requireVersion(body.expectedVersion),
    ipAddress: requestMeta.ipAddress || "0.0.0.0"
  };
}

/**
 * Validate a new-account creation body. Generates a temporary password when
 * the caller does not supply one, so the admin can hand it to the new user.
 */
export function validateCreate(
  body: JsonObject = {},
  requestMeta: Partial<RequestMeta> = {}
): { input: AccountCreateInput; generatedPassword: string | null } {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";

  if (!email && !phone) {
    throw validationError("email", "email hoặc phone là bắt buộc");
  }
  if (email && !validateEmail(email)) {
    throw validationError("email", "email không đúng định dạng");
  }
  if (phone && !validatePhone(phone)) {
    throw validationError("phone", "phone không đúng định dạng");
  }
  if (!fullName) {
    throw validationError("fullName", "fullName là bắt buộc");
  }

  const role = typeof body.role === "string" ? body.role : "";
  if (!ACCOUNT_ROLES.includes(role)) {
    throw validationError("role", "role must be member or admin");
  }
  const adminRole = body.adminRole ?? null;
  if (role === "admin" && (typeof adminRole !== "string" || !ADMIN_ROLES.includes(adminRole))) {
    throw validationError("adminRole", "A valid adminRole is required for admin accounts");
  }
  if (role === "member" && adminRole !== null) {
    throw validationError("adminRole", "adminRole must be null for members");
  }

  const suppliedPassword = typeof body.password === "string" && body.password ? body.password : null;
  const generatedPassword = suppliedPassword ? null : generateTemporaryPassword();
  const password = suppliedPassword || generatedPassword!;
  if (!validatePassword(password)) {
    throw validationError("password", "password phải tối thiểu 8 ký tự, gồm chữ hoa, chữ thường và số hoặc ký tự đặc biệt");
  }

  return {
    input: {
      email: email || null,
      phone: phone || null,
      fullName,
      password,
      role,
      adminRole: typeof adminRole === "string" ? adminRole : null,
      ipAddress: requestMeta.ipAddress || "0.0.0.0"
    },
    generatedPassword
  };
}

const TEMP_PASSWORD_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const TEMP_PASSWORD_LOWER = "abcdefghijkmnpqrstuvwxyz";
const TEMP_PASSWORD_DIGIT = "23456789";
const TEMP_PASSWORD_SPECIAL = "!@#$%^&*";
const TEMP_PASSWORD_ALL = TEMP_PASSWORD_UPPER + TEMP_PASSWORD_LOWER + TEMP_PASSWORD_DIGIT + TEMP_PASSWORD_SPECIAL;
const TEMP_PASSWORD_LENGTH = 14;

/**
 * Generates a cryptographically random password that satisfies the platform's
 * complexity rule (uppercase + lowercase + digit-or-special, 8+ chars).
 */
function generateTemporaryPassword(): string {
  const required = [
    randomChar(TEMP_PASSWORD_UPPER),
    randomChar(TEMP_PASSWORD_LOWER),
    randomChar(TEMP_PASSWORD_DIGIT),
    randomChar(TEMP_PASSWORD_SPECIAL)
  ];
  const rest = Array.from({ length: TEMP_PASSWORD_LENGTH - required.length }, () => randomChar(TEMP_PASSWORD_ALL));
  return shuffle([...required, ...rest]).join("");
}

function randomChar(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)];
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Count whitespace-separated words in a free-text reason.
 */
export function countWords(value: unknown): number {
  const text = String(value ? value : "").trim();
  return text ? text.split(/\s+/u).filter(Boolean).length : 0;
}

function requireAccountAdmin(
  context: AuthContext | undefined
): asserts context is AuthContext & { profile: UserProfile; authUser: AuthUser } {
  if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
  if (!context.isAdmin || !context.profile?.is_active || context.roleCode !== "super_admin") {
    throw new HttpError(403, "RBAC_DENIED", "Only an active super admin can manage accounts");
  }
}

function parseListFilters(searchParams: URLSearchParams): AccountListFilters {
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

function parseRequestFilters(searchParams: URLSearchParams): AccountRequestFilters {
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

function requireReason(value: unknown, field = "reason"): string {
  const reason = String(value ? value : "").trim().replace(/\s+/g, " ");
  if (countWords(reason) <= 10) {
    throw validationError(field, `${field} must contain more than 10 words`);
  }
  if (reason.length > 1000) throw validationError(field, `${field} must be at most 1000 characters`);
  return reason;
}

function requireVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw validationError("expectedVersion", "expectedVersion must be a positive integer");
  }
  return version;
}

function optionalText(value: unknown, maxLength: number): string {
  const text = String(value ? value : "").trim().replace(/\s+/g, " ");
  if (text.length > maxLength) throw validationError("note", `note must be at most ${maxLength} characters`);
  return text;
}

function parseFutureDate(value: unknown, field: string): string {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : new Date(Number.NaN);
  if (Number.isNaN(date.getTime()) || date <= new Date()) {
    throw validationError(field, `${field} must be a future ISO date`);
  }
  return date.toISOString();
}

function requireUuid(value: unknown, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ? value : ""))) {
    throw validationError(field, `${field} must be a UUID`);
  }
}

function clampInteger(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  const number = Number(raw);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function validationError(field: string, message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { [field]: [message] });
}
