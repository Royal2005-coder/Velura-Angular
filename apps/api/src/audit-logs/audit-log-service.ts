import { ALL_AUDIT_TARGETS, enrichAuditLogs } from "../audit-enrichment.js";
import { HttpError } from "../http.js";
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
  "support"
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
      const payload = await repository.list(parseListFilters(searchParams), context.accessToken);
      // Trang nhật ký trộn nhiều phân hệ nên tra đối tượng theo `module` của từng dòng.
      return enrichAuditLogs(payload, { targets: ALL_AUDIT_TARGETS });
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
  let resolvedModule = module || undefined;
  let modules: string[] | undefined;
  if (!resolvedModule && scope === "admin") {
    modules = ADMIN_MODULES;
  } else if (!resolvedModule && scope === "system") {
    resolvedModule = "system";
  } else if (!resolvedModule && scope === "ai") {
    resolvedModule = "ai";
  }
  return {
    module: resolvedModule,
    modules,
    q: q || undefined,
    targetId: searchParams.get("targetId") || undefined,
    limit: integer(searchParams.get("limit"), 50, 1, 1000),
    offset: integer(searchParams.get("offset"), 0, 0, 1_000_000)
  };
}

function integer(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}
