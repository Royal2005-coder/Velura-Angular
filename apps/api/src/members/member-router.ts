import { config } from "../config.js";
import { getRequestIp, readJson, sendJson } from "../http.js";
import type { RouteArgs } from "../types.js";
import type { MemberService } from "./member-service.js";

/**
 * Admin member routes under `/api/v1/admin/members` (KAN-106).
 *
 * Router chỉ đọc HTTP: parse path, parse body, gọi service. Quyền `members` và audit nằm trong
 * RPC (migration 079); ở đây không có đường ghi điểm, chỉ có khoá/mở tích luỹ kèm lý do.
 */
export async function handleMemberRoute({
  req,
  res,
  url,
  parts,
  context,
  headers,
  service,
}: RouteArgs<MemberService>): Promise<boolean> {
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "admin" || parts[3] !== "members") {
    return false;
  }

  if (req.method === "GET" && parts.length === 4) {
    sendJson(res, 200, await service.listMembers(context, url.searchParams), headers);
    return true;
  }

  if (req.method === "GET" && parts.length === 5 && parts[4] === "overview") {
    sendJson(res, 200, await service.overview(context), headers);
    return true;
  }

  const userId = parts[4];
  if (req.method === "GET" && userId && parts.length === 5) {
    sendJson(res, 200, await service.memberDetail(context, userId), headers);
    return true;
  }

  if (req.method === "POST" && userId && parts.length === 6 && parts[5] === "accrual-lock") {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.setAccrualLock(context, userId, body, { ipAddress: getRequestIp(req) }), headers);
    return true;
  }

  return false;
}
