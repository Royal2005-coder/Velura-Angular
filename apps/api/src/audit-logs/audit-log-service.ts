import { ALL_AUDIT_TARGETS, enrichAuditLogs } from "../audit-enrichment.js";
import { HttpError } from "../http.js";
import { hasCapability } from "../rbac.js";
import { SEARCH_SCAN_LIMIT, searchMatches } from "../search-text.js";
import type { AuthContext, JsonObject } from "../types.js";
import type { AuditLogListFilters, AuditLogRepository } from "./audit-log-repository.js";

const MODULE_PATTERN = /^[a-z0-9_-]{1,50}$/;
const ADMIN_MODULES = [
  "accounts",
  "products",
  "orders",
  "pricing",
  "promotions",
  "vouchers",
  "returns",
  "reviews",
  "support",
  "content",
  "members"
];

/**
 * Audit-log methods the admin audit-log router calls.
 */
export interface AuditLogService {
  list(
    context: AuthContext | undefined,
    searchParams: URLSearchParams
  ): Promise<{ rows: JsonObject[]; count: number | undefined }>;
}

/**
 * Admin audit-log listing over an audit-log repository.
 */
export function createAuditLogService({ repository }: { repository: AuditLogRepository }): AuditLogService {
  return {
    async list(context, searchParams) {
      if (!context?.authUser?.id || !context.isAdmin || !context.profile?.is_active) {
        throw new HttpError(403, "RBAC_DENIED", "Only active administrators can view audit logs");
      }
      // Active admin is necessary but not sufficient: the role matrix decides whether this
      // operator may read the audit module at all (admin_viewer may not).
      if (!hasCapability(context, "audit_logs", "read")) {
        throw new HttpError(403, "RBAC_DENIED", "Insufficient permissions to view audit logs");
      }
      const filters = parseListFilters(searchParams);
      scopeAuditModules(context, filters);
      const q = filters.q;
      const actor = filters.actor;
      const scan = Boolean(q || actor);
      // `action` is an enum and the id columns are uuid, so PostgREST `ilike` on them fails
      // with a 404 SUPABASE_ERROR (UAT TC_ACC_16). A query reads a bounded window, enriches
      // it, and matches folded text — labels included — in Node.
      const payload = await repository.list(
        { ...filters, q: undefined, actor: undefined, limit: scan ? SEARCH_SCAN_LIMIT : filters.limit, offset: scan ? 0 : filters.offset },
        context.accessToken
      );
      // Trang nhật ký trộn nhiều phân hệ nên tra đối tượng theo `module` của từng dòng.
      const enriched = await enrichAuditLogs(payload, { targets: ALL_AUDIT_TARGETS });
      if (!scan) return enriched;
      const matched = enriched.rows.filter((row) =>
        searchMatches(q || "", row.action, row.action_label, row.module, row.actor_id, row.actor_label,
          row.target_id, row.target_label, row.ip_address)
        && searchMatches(actor || "", row.actor_id, row.actor_label)
      );
      return { rows: matched.slice(filters.offset, filters.offset + filters.limit), count: matched.length };
    }
  };
}

/**
 * Parses list query params for module, admin scope, and free-text search.
 */
export function parseAuditLogFilters(searchParams: URLSearchParams): AuditLogListFilters {
  return parseListFilters(searchParams);
}

function parseListFilters(searchParams: URLSearchParams): AuditLogListFilters {
  const module = searchParams.get("module") || "";
  const scope = searchParams.get("scope") || "";
  const q = String(searchParams.get("q") || "").trim().slice(0, 100);
  if (module && !MODULE_PATTERN.test(module)) throw new HttpError(422, "VALIDATION_ERROR", "Invalid audit module");
  if (scope && !["admin", "system", "ai"].includes(scope)) {
    throw new HttpError(422, "VALIDATION_ERROR", "Invalid audit scope");
  }
  const from = isoBound(searchParams.get("from"), "from");
  const to = isoBound(searchParams.get("to"), "to");
  let resolvedModule = module || undefined;
  let modules: string[] | undefined;
  if (!resolvedModule && scope === "admin") {
    modules = ADMIN_MODULES;
  } else if (!resolvedModule && scope === "system") {
    // Sign-in/out events are system events for the admin audit page.
    modules = ["system", "auth"];
  } else if (!resolvedModule && scope === "ai") {
    resolvedModule = "ai";
  }
  return {
    module: resolvedModule,
    modules,
    q: q || undefined,
    actor: String(searchParams.get("actor") || "").trim().slice(0, 100) || undefined,
    from,
    to,
    targetId: searchParams.get("targetId") || undefined,
    limit: integer(searchParams.get("limit"), 50, 1, 1000),
    offset: integer(searchParams.get("offset"), 0, 0, 1_000_000)
  };
}

function isoBound(value: string | null, field: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new HttpError(422, "VALIDATION_ERROR", `Invalid ${field} timestamp`);
  return parsed.toISOString();
}

function integer(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

/**
 * A professional role may read the audit trail only for the modules it operates. Super admin
 * (`*`) sees everything; asking for a module outside the role's matrix is a 403, and an
 * unscoped list is narrowed to the permitted modules instead of leaking `accounts`
 * (UAT TC_ACC_02/16).
 */
function scopeAuditModules(context: AuthContext, filters: AuditLogListFilters): void {
  const modules = context.allowedModules || [];
  if (modules.includes("*")) return;
  const permitted = modules.filter((module) => module !== "audit_logs");
  if (filters.module) {
    if (!permitted.includes(filters.module)) {
      throw new HttpError(403, "RBAC_DENIED", "Insufficient permissions to view this audit module");
    }
    return;
  }
  const requested = filters.modules?.length ? filters.modules : ADMIN_MODULES;
  const allowed = requested.filter((module) => permitted.includes(module));
  if (!allowed.length) {
    throw new HttpError(403, "RBAC_DENIED", "Insufficient permissions to view audit logs");
  }
  filters.module = undefined;
  filters.modules = allowed;
}
