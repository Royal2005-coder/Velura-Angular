import { HttpError } from "../http.js";
import { callRpc, selectOne, selectRows } from "../supabase.js";
import { asString, isJsonObject, type JsonObject } from "../types.js";
import { ACCOUNT_SELECT } from "./account-constants.js";

/**
 * List filters for `users` account search.
 */
export interface AccountListFilters {
  q?: string;
  role?: string;
  adminRole?: string;
  isActive?: boolean;
  limit: number;
  offset: number;
  order: string;
}

/**
 * List filters for `approval_admin_request`.
 */
export interface AccountRequestFilters {
  status?: string;
  limit: number;
  offset: number;
}

/**
 * List filters for account-module audit rows.
 */
export interface AccountAuditFilters {
  targetId?: string;
  limit: number;
  offset: number;
}

/**
 * Lock RPC input after validation.
 */
export interface AccountLockInput {
  lockType: string;
  reason: string;
  expectedVersion: number;
  lockedUntil: string | null;
  ipAddress: string;
}

/**
 * Unlock RPC input after validation.
 */
export interface AccountUnlockInput {
  reason: string;
  expectedVersion: number;
  ipAddress: string;
}

/**
 * Role-change RPC input after validation.
 */
export interface AccountRoleChangeInput {
  role: string;
  adminRole: string | null;
  expectedVersion: number;
  ipAddress: string;
}

/**
 * Approval review RPC input after validation.
 */
export interface AccountReviewInput {
  decision: string;
  expectedVersion: number;
  note: string;
  ipAddress: string;
}

/**
 * Persistence surface used by `createAccountService`.
 */
export interface AccountRepository {
  list(
    filters: AccountListFilters,
    accessToken: string
  ): Promise<{ rows: JsonObject[]; count: number | undefined }>;
  findById(userId: string, accessToken: string): Promise<JsonObject | null>;
  listRoleRequests(
    filters: AccountRequestFilters,
    accessToken: string
  ): Promise<{ rows: JsonObject[]; count: number | undefined }>;
  listAuditLogs(
    filters: AccountAuditFilters,
    accessToken: string
  ): Promise<{ rows: JsonObject[]; count: number | undefined }>;
  lock(
    userId: string,
    input: AccountLockInput,
    actorId: string,
    accessToken: string
  ): Promise<unknown>;
  unlock(
    userId: string,
    input: AccountUnlockInput,
    actorId: string,
    accessToken: string
  ): Promise<unknown>;
  changeRole(
    userId: string,
    input: AccountRoleChangeInput,
    actorId: string,
    accessToken: string
  ): Promise<unknown>;
  reviewRoleRequest(
    requestId: string,
    input: AccountReviewInput,
    accessToken: string
  ): Promise<unknown>;
}

/**
 * PostgREST + RPC implementation of account persistence.
 */
export function createAccountRepository(): AccountRepository {
  return {
    async list(filters, accessToken) {
      const query: Record<string, unknown> = {
        select: ACCOUNT_SELECT,
        order: filters.order,
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.q) {
        const value = sanitizeSearch(filters.q);
        if (value) query.or = `(full_name.ilike.*${value}*,email.ilike.*${value}*,phone.ilike.*${value}*)`;
      }
      if (filters.role) query.role = `eq.${filters.role}`;
      if (filters.adminRole) query.admin_role = `eq.${filters.adminRole}`;
      if (filters.isActive !== undefined) query.is_active = `eq.${filters.isActive}`;
      return withAccountError(() => selectRows("users", query, authOptions(accessToken)));
    },

    async findById(userId, accessToken) {
      return withAccountError(() => selectOne("users", {
        select: ACCOUNT_SELECT,
        user_id: `eq.${userId}`
      }, authOptions(accessToken)));
    },

    async listRoleRequests(filters, accessToken) {
      const query: Record<string, unknown> = {
        select: "request_id,requester_id,target_user_id,requested_role,status,approver_id,admin_note,created_at,expires_at,resolved_at,target_version,version",
        order: "created_at.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.status) query.status = `eq.${filters.status}`;
      return withAccountError(() => selectRows("approval_admin_request", query, authOptions(accessToken)));
    },

    async listAuditLogs(filters, accessToken) {
      const query: Record<string, unknown> = {
        select: "audit_id,actor_id,actor_role,action,module,target_id,old_value,new_value,ip_address,timestamp",
        module: "eq.accounts",
        order: "timestamp.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.targetId) query.target_id = `eq.${filters.targetId}`;
      return withAccountError(() => selectRows("audit_log", query, authOptions(accessToken)));
    },

    lock(userId, input, _actorId, accessToken) {
      return rpc("admin_lock_user", {
        p_target_user_id: userId,
        p_lock_type: input.lockType,
        p_reason: input.reason,
        p_expected_version: input.expectedVersion,
        p_locked_until: input.lockedUntil || null,
        p_ip_address: input.ipAddress
      }, accessToken);
    },

    unlock(userId, input, _actorId, accessToken) {
      return rpc("admin_unlock_user", {
        p_target_user_id: userId,
        p_reason: input.reason,
        p_expected_version: input.expectedVersion,
        p_ip_address: input.ipAddress
      }, accessToken);
    },

    changeRole(userId, input, _actorId, accessToken) {
      return rpc("admin_change_user_role", {
        p_target_user_id: userId,
        p_role: input.role,
        p_admin_role: input.adminRole,
        p_expected_version: input.expectedVersion,
        p_ip_address: input.ipAddress
      }, accessToken);
    },

    reviewRoleRequest(requestId, input, accessToken) {
      return rpc("admin_review_role_request", {
        p_request_id: requestId,
        p_decision: input.decision,
        p_action_note: input.note || "",
        p_expected_version: input.expectedVersion,
        p_ip_address: input.ipAddress
      }, accessToken);
    }
  };
}

async function rpc(name: string, payload: unknown, accessToken: string): Promise<unknown> {
  return withAccountError(() => callRpc(name, payload, authOptions(accessToken)));
}

function authOptions(accessToken: string): { useAnonKey: true; accessToken: string } {
  return { useAnonKey: true, accessToken };
}

function sanitizeSearch(value: unknown): string {
  return String(value ? value : "").replace(/[,*()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

async function withAccountError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError && error.code === "SUPABASE_ERROR") {
      const details = isJsonObject(error.details) ? error.details : {};
      const databaseCode = asString(details.message) || asString(details.code) || "ACCOUNT_DATABASE_ERROR";
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      throw new HttpError(status, databaseCode, accountErrorMessage(databaseCode), error.details);
    }
    throw error;
  }
}

function accountErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    RBAC_DENIED: "You do not have permission to manage accounts",
    ACCOUNT_NOT_FOUND: "Account was not found",
    VERSION_CONFLICT: "Account data changed; reload before trying again",
    TARGET_VERSION_CONFLICT: "Target account changed after the approval was created",
    LAST_SUPER_ADMIN: "The last active super admin cannot be locked or demoted",
    ACCOUNT_ALREADY_LOCKED: "Account is already locked",
    ACCOUNT_ALREADY_ACTIVE: "Account is already active",
    PENDING_APPROVAL_EXISTS: "A pending super admin request already exists",
    APPROVAL_NOT_FOUND: "Approval request was not found",
    APPROVAL_ALREADY_RESOLVED: "Approval request was already resolved",
    APPROVAL_SEPARATION_REQUIRED: "Requester, target and approver must be different accounts",
    REASON_MIN_11_WORDS: "Reason must contain more than 10 words",
    REJECTION_REASON_MIN_11_WORDS: "Rejection reason must contain more than 10 words"
  };
  return messages[code] || "Account database operation failed";
}
