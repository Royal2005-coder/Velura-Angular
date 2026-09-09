import { HttpError } from "../http.js";

const MODULE_PATTERN = /^[a-z0-9_-]{1,50}$/;

export function createAuditLogService({ repository }) {
  return {
    list(context, searchParams) {
      if (!context?.authUser?.id || !context.isAdmin || !context.profile?.is_active) {
        throw new HttpError(403, "RBAC_DENIED", "Only active administrators can view audit logs");
      }
      const module = searchParams.get("module") || "";
      if (module && !MODULE_PATTERN.test(module)) throw new HttpError(422, "VALIDATION_ERROR", "Invalid audit module");
      return repository.list({
        module: module || undefined,
        targetId: searchParams.get("targetId") || undefined,
        limit: integer(searchParams.get("limit"), 50, 1, 1000),
        offset: integer(searchParams.get("offset"), 0, 0, 1_000_000)
      }, context.accessToken);
    }
  };
}

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}
