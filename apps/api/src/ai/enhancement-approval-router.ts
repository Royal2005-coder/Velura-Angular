import { getRequestIp, HttpError, readJson, sendJson } from "../http.js";
import type { RouteArgs } from "../types.js";
import type { EnhancementApprovalService } from "./enhancement-approval-service.js";

/** Parse deliberate image selection; inference, review and atomic catalog publication remain separate. */
export async function handleEnhancementApprovalRoute({ req, res, parts, context, headers, service }: RouteArgs<EnhancementApprovalService>): Promise<boolean> {
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "admin" || parts[3] !== "image-enhancement-approvals") return false;
  if (req.method !== "POST" || parts.length !== 4)
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Only explicit image approval is supported");
  const approval = await service.approve(context, await readJson(req, 16 * 1024), { ipAddress: getRequestIp(req) });
  sendJson(res, 201, approval, { ...headers, "cache-control": "no-store" });
  return true;
}
