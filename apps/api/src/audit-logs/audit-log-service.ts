import { HttpError } from "../http.js";
import type { AuthContext, JsonObject } from "../types.js";
import type { AuditLogListFilters, AuditLogRepository } from "./audit-log-repository.js";

const MODULE_PATTERN = /^[a-z0-9_-]{1,50}$/;

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
    list(context, searchParams) {
      if (!context?.authUser?.id || !context.isAdmin || !context.profile?.is_active) {
        throw new HttpError(403, "RBAC_DENIED", "Only active administrators can view audit logs");
      }
      const module = searchParams.get("module") || "";
      if (module && !MODULE_PATTERN.test(module)) throw new HttpError(422, "VALIDATION_ERROR", "Invalid audit module");
      const filters: AuditLogListFilters = {
        module: module || undefined,
        targetId: searchParams.get("targetId") || undefined,
        limit: integer(searchParams.get("limit"), 50, 1, 1000),
        offset: integer(searchParams.get("offset"), 0, 0, 1_000_000)
      };
      return repository.list(filters, context.accessToken);
    }
  };
}

function integer(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}
