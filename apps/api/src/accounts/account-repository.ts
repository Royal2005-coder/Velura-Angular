import { hashPassword } from "../auth-helper.js";
import { config } from "../config.js";
import { HttpError } from "../http.js";
import { callRpc, insertRow, quotePostgrestValue, selectOne, selectRows } from "../supabase.js";
import { SEARCH_SCAN_LIMIT, searchMatches } from "../search-text.js";
import { asJsonObject, asString, isJsonObject, type JsonObject } from "../types.js";
import { ACCOUNT_SELECT } from "./account-constants.js";
import { writeAuditLog } from "../audit.js";

/**
 * List filters for `users` account search.
 */
export interface AccountListFilters {
  q?: string;
  role?: string;
  adminRole?: string;
  isActive?: boolean;
  /**
   * `is_active = false` gộp hai tình huống khác hẳn nhau: bị admin khoá, và đăng ký
   * xong chưa nhập OTP. Bộ lọc này tách chúng ra để tab "Bị khoá" không đếm nhầm
   * người dùng bỏ dở đăng ký.
   */
  lockState?: "locked" | "unverified";
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
 * New-account creation input after validation.
 */
export interface AccountCreateInput {
  email: string | null;
  phone: string | null;
  fullName: string;
  password: string;
  role: string;
  adminRole: string | null;
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
  create(
    input: AccountCreateInput,
    actorId: string,
    actorRole: string
  ): Promise<JsonObject>;
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
      const search = String(filters.q || "").trim();
      const pageLimit = Math.max(1, filters.limit || 20);
      const pageOffset = Math.max(0, filters.offset || 0);
      const query: Record<string, unknown> = {
        select: ACCOUNT_SELECT,
        // Tie-break on the primary key so equal timestamps never reorder the page between
        // calls or duplicate/lose rows across pages (UAT TC_ACC_03).
        order: `${filters.order},user_id.asc`,
        // `ilike` cannot fold Vietnamese accents, so a query widens the window and matches
        // in Node (search-text.ts) across name, email and phone (UAT TC_ACC_04).
        limit: search ? String(SEARCH_SCAN_LIMIT) : filters.limit,
        offset: search ? "0" : filters.offset
      };
      if (filters.role) query.role = `eq.${filters.role}`;
      if (filters.adminRole) query.admin_role = `eq.${filters.adminRole}`;
      if (filters.isActive !== undefined) query.is_active = `eq.${filters.isActive}`;
      if (filters.lockState === "locked") {
        query.lock_type = "not.is.null";
      } else if (filters.lockState === "unverified") {
        query.is_active = "eq.false";
        query.lock_type = "is.null";
      }
      const result = await withAccountError(() => selectRows("users", query, authOptions(accessToken)));
      if (!search) return result;
      const matched = result.rows.filter((row) => searchMatches(search, row.full_name, row.email, row.phone));
      return { rows: matched.slice(pageOffset, pageOffset + pageLimit), count: matched.length };
    },

    async findById(userId, accessToken) {
      return withAccountError(() => selectOne("users", {
        select: ACCOUNT_SELECT,
        user_id: `eq.${userId}`
      }, authOptions(accessToken)));
    },

    async create(input, actorId, actorRole) {
      return withAccountError(async () => {
        if (input.email) {
          const existingEmail = await selectOne("users", { email: `eq.${input.email}` });
          if (existingEmail) {
            throw new HttpError(409, "DUPLICATE_ACCOUNT", "Email đã được sử dụng trên hệ thống");
          }
        }
        if (input.phone) {
          const existingPhone = await selectOne("users", { phone: `eq.${input.phone}` });
          if (existingPhone) {
            throw new HttpError(409, "DUPLICATE_ACCOUNT", "Số điện thoại đã được sử dụng trên hệ thống");
          }
        }
        // The profile row alone cannot sign in: /auth/v1/token is issued by Supabase Auth.
        // Create the GoTrue user first and link it, rolling it back if the profile fails.
        const authUserId = input.email
          ? await createAuthIdentity(input.email, input.password, input.fullName)
          : null;
        try {
          const created = asJsonObject(await insertRow("users", {
            email: input.email,
            phone: input.phone,
            full_name: input.fullName,
            auth_user_id: authUserId,
            password_hash: hashPassword(input.password),
            role: input.role,
            admin_role: input.adminRole,
            is_active: true,
            is_verified: true
          }));
          await writeAuditLog({
            actor_id: actorId,
            actor_role: actorRole,
            action: "create",
            module: "accounts",
            target_id: asString(created.user_id) || null,
            old_value: null,
            new_value: { email: created.email, phone: created.phone, role: created.role, admin_role: created.admin_role },
            ip_address: asString(input.ipAddress) || "127.0.0.1",
            timestamp: new Date().toISOString()
          });
          const { password_hash: _passwordHash, otp_code: _otpCode, otp_expires_at: _otpExpiresAt, ...safeAccount } = created;
          return safeAccount;
        } catch (error) {
          if (authUserId) {
            await deleteAuthIdentity(authUserId).catch(() => undefined);
          }
          throw error;
        }
      });
    },

    async listRoleRequests(filters, accessToken) {
      const query: Record<string, unknown> = {
        select: "request_id,requester_id,target_user_id,requested_role,status,approver_id,action_note,created_at,expires_at,resolved_at,target_version,version",
        order: "created_at.desc,request_id.asc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.status) query.status = `eq.${filters.status}`;
      const result = await withAccountError(() => selectRows("approval_admin_request", query, authOptions(accessToken)));
      // Operators decide on people, not UUIDs: join the target/requester display fields and
      // expose the reject note, which the table previously dropped (UAT TC_ACC_12/14).
      const ids = Array.from(new Set(
        result.rows.flatMap((row) => [row.target_user_id, row.requester_id]).map((value) => asString(value)).filter(Boolean)
      ));
      if (!ids.length) return result;
      const { rows: users } = await selectRows("users", {
        select: "user_id,email,full_name",
        user_id: `in.(${ids.map(quotePostgrestValue).join(",")})`,
        limit: ids.length
      }, { count: "none" }).catch(() => ({ rows: [] as JsonObject[] }));
      const byId = new Map(users.map((user) => [asString(user.user_id), user]));
      const label = (id: unknown) => {
        const user = byId.get(asString(id));
        return {
          email: user ? asString(user.email) : undefined,
          name: user ? asString(user.full_name) : undefined
        };
      };
      return {
        count: result.count,
        rows: result.rows.map((row) => ({
          ...row,
          target_email: label(row.target_user_id).email,
          target_name: label(row.target_user_id).name,
          requester_email: label(row.requester_id).email,
          requester_name: label(row.requester_id).name,
          rejection_reason: row.status === "rejected" ? (asString(row.action_note) || null) : null
        }))
      };
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

/**
 * Creates the Supabase Auth identity a password sign-in needs. The public.users row alone
 * cannot obtain a token, so a freshly created admin must exist in GoTrue too (TC_ACC_05).
 */
async function createAuthIdentity(email: string, password: string, fullName: string): Promise<string> {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new HttpError(503, "AUTH_NOT_CONFIGURED", "Chưa cấu hình Supabase Auth để tạo đăng nhập cho tài khoản.");
  }
  const response = await fetch(`${config.supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: config.supabaseServiceRoleKey,
      authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: fullName } }),
    signal: AbortSignal.timeout(15_000)
  });
  const payload = (await response.json().catch(() => ({}))) as JsonObject;
  if (!response.ok) {
    const detail = `${asString(payload.msg)} ${asString(payload.message)} ${asString(payload.error_description)}`.toLowerCase();
    if (response.status === 409 || response.status === 422 || detail.includes("already") || detail.includes("registered") || detail.includes("exists")) {
      throw new HttpError(409, "DUPLICATE_ACCOUNT", "Email đã được sử dụng trên hệ thống");
    }
    throw new HttpError(502, "AUTH_CREATE_FAILED", "Không tạo được đăng nhập Supabase cho tài khoản mới.");
  }
  const id = asString(payload.id);
  if (!id) throw new HttpError(502, "AUTH_CREATE_FAILED", "Supabase Auth không trả về mã người dùng.");
  return id;
}

/** Best-effort rollback when the profile insert fails after the Auth user was created. */
async function deleteAuthIdentity(userId: string): Promise<void> {
  await fetch(`${config.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: {
      apikey: config.supabaseServiceRoleKey,
      authorization: `Bearer ${config.supabaseServiceRoleKey}`
    },
    signal: AbortSignal.timeout(10_000)
  });
}

async function withAccountError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError && error.code === "SUPABASE_ERROR") {
      const details = isJsonObject(error.details) ? error.details : {};
      const databaseCode = asString(details.message) || asString(details.code) || "ACCOUNT_DATABASE_ERROR";
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      // The raw PostgREST envelope (code/details/hint) must not reach the operator UI:
      // UAT saw "code: PT409 · details: null · hint: null" instead of a Vietnamese message.
      throw new HttpError(status, databaseCode, accountErrorMessage(databaseCode));
    }
    throw error;
  }
}

function accountErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    RBAC_DENIED: "Bạn không có quyền quản lý tài khoản",
    ACCOUNT_NOT_FOUND: "Không tìm thấy tài khoản",
    VERSION_CONFLICT: "Tài khoản vừa được cập nhật ở phiên khác. Vui lòng tải lại trang và thử lại.",
    TARGET_VERSION_CONFLICT: "Tài khoản đích đã thay đổi sau khi yêu cầu được tạo. Vui lòng tải lại.",
    LAST_SUPER_ADMIN: "Không thể khóa hoặc hạ quyền Super Admin đang hoạt động cuối cùng.",
    ACCOUNT_ALREADY_LOCKED: "Tài khoản đã bị khóa trước đó.",
    ACCOUNT_ALREADY_ACTIVE: "Tài khoản đang hoạt động, không cần mở khóa.",
    ACCOUNT_NOT_LOCKED: "Tài khoản chưa từng bị khóa (có thể chưa xác thực đăng ký). Không thể mở khóa.",
    PENDING_APPROVAL_EXISTS: "Đã có yêu cầu nâng quyền super admin đang chờ duyệt cho tài khoản này.",
    APPROVAL_NOT_FOUND: "Không tìm thấy yêu cầu nâng quyền",
    APPROVAL_ALREADY_RESOLVED: "Yêu cầu nâng quyền đã được xử lý trước đó.",
    APPROVAL_SEPARATION_REQUIRED: "Người yêu cầu, tài khoản đích và người duyệt phải là ba tài khoản khác nhau.",
    REASON_MIN_11_WORDS: "Lý do phải có hơn 10 từ có nghĩa.",
    REJECTION_REASON_MIN_11_WORDS: "Lý do từ chối phải có hơn 10 từ có nghĩa.",
    AUTH_NOT_CONFIGURED: "Chưa cấu hình Supabase Auth để tạo đăng nhập cho tài khoản.",
    AUTH_CREATE_FAILED: "Không tạo được đăng nhập Supabase cho tài khoản mới."
  };
  return messages[code] || "Thao tác tài khoản thất bại. Vui lòng thử lại.";
}
