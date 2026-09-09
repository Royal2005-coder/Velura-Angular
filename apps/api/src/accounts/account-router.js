import { config } from "../config.js";
import { getRequestIp, readJson, sendJson } from "../http.js";

export async function handleAccountRoute({ req, res, url, parts, context, headers, service }) {
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "admin") return false;

  const requestMeta = { ipAddress: getRequestIp(req) };
  if (parts[3] === "accounts") {
    if (req.method === "GET" && parts.length === 4) {
      sendJson(res, 200, await service.list(context, url.searchParams), headers);
      return true;
    }
    if (req.method === "GET" && parts[4] === "roles" && parts.length === 5) {
      sendJson(res, 200, { data: service.roles(context) }, headers);
      return true;
    }

    const userId = parts[4];
    if (req.method === "GET" && userId && parts.length === 5) {
      sendJson(res, 200, await service.get(context, userId), headers);
      return true;
    }
    if (req.method === "POST" && userId && parts.length === 6) {
      const body = await readJson(req, config.maxBodyBytes);
      const action = parts[5];
      if (action === "lock") {
        sendJson(res, 200, await service.lock(context, userId, body, requestMeta), headers);
        return true;
      }
      if (action === "unlock") {
        sendJson(res, 200, await service.unlock(context, userId, body, requestMeta), headers);
        return true;
      }
      if (action === "role") {
        const result = await service.changeRole(context, userId, body, requestMeta);
        sendJson(res, result?.kind === "approval" ? 202 : 200, result, headers);
        return true;
      }
    }
  }

  if (parts[3] === "account-role-requests") {
    if (req.method === "GET" && parts.length === 4) {
      sendJson(res, 200, await service.listRoleRequests(context, url.searchParams), headers);
      return true;
    }
    if (req.method === "POST" && parts.length === 6) {
      const body = await readJson(req, config.maxBodyBytes);
      const result = await service.reviewRoleRequest(context, parts[4], parts[5], body, requestMeta);
      sendJson(res, result?.kind === "expired" ? 409 : 200, result, headers);
      return true;
    }
  }

  if (parts[3] === "account-audit-logs" && req.method === "GET" && parts.length === 4) {
    sendJson(res, 200, await service.listAuditLogs(context, url.searchParams), headers);
    return true;
  }

  return false;
}
