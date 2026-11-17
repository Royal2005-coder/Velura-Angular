import { requirePermission } from "../rbac.js";
import type { AuthContext } from "../types.js";

/** Module RBAC chung của banner, bộ sưu tập và tải media CMS. */
const CMS_MODULE = "content";

/**
 * Chặn thao tác CMS admin theo quyền module `content`.
 * GET → `read`; POST → `create`; PUT/PATCH/DELETE → `update` (module `content` không có quyền `delete`).
 * @throws HttpError 403 `RBAC_DENIED` khi role không đủ quyền.
 */
export function requireCmsPermission(context: AuthContext, method: string | undefined): void {
  const verb = (method || "GET").toUpperCase();
  const action = verb === "GET" || verb === "HEAD" ? "read" : verb === "POST" ? "create" : "update";
  requirePermission(context, CMS_MODULE, action);
}
