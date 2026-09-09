import { config } from "../config.js";
import { getRequestIp, readJson, sendJson } from "../http.js";

export async function handleReturnRoute({ req, res, url, parts, context, headers, service }) {
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "admin") return false;

  if (parts[3] === "returns") {
    const requestMeta = { ipAddress: getRequestIp(req) };

    if (req.method === "GET" && parts.length === 4) {
      sendJson(res, 200, await service.listReturns(context, url.searchParams), headers);
      return true;
    }

    const returnId = parts[4];
    if (!returnId) return false;

    if (req.method === "GET" && parts.length === 5) {
      sendJson(res, 200, await service.getReturn(context, returnId), headers);
      return true;
    }

    if (req.method === "POST" && parts[5] === "approve-refund" && parts.length === 6) {
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.approveRefund(context, returnId, body), headers);
      return true;
    }

    if (req.method === "POST" && parts[5] === "approve-exchange" && parts.length === 6) {
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.approveExchange(context, returnId, body), headers);
      return true;
    }

    if (req.method === "POST" && parts[5] === "reject" && parts.length === 6) {
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.reject(context, returnId, body), headers);
      return true;
    }

    if (req.method === "POST" && parts[5] === "update-status" && parts.length === 6) {
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.updateReturnStatus(context, returnId, body), headers);
      return true;
    }
  }

  if (parts[3] === "service-audit-logs" && req.method === "GET" && parts.length === 4) {
    sendJson(res, 200, await service.listAuditLogs(context, url.searchParams), headers);
    return true;
  }

  if (parts[3] === "support-tickets") {
    if (req.method === "GET" && parts.length === 4) {
      sendJson(res, 200, await service.listTickets(context, url.searchParams), headers);
      return true;
    }

    const ticketId = parts[4];
    if (!ticketId) return false;

    if (req.method === "GET" && parts.length === 5) {
      sendJson(res, 200, await service.getTicket(context, ticketId), headers);
      return true;
    }

    if (req.method === "POST" && parts[5] === "assign" && parts.length === 6) {
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.assignTicket(context, ticketId, body), headers);
      return true;
    }

    if (req.method === "POST" && parts[5] === "respond" && parts.length === 6) {
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.respondTicket(context, ticketId, body), headers);
      return true;
    }

    if (req.method === "POST" && parts[5] === "close" && parts.length === 6) {
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.closeTicket(context, ticketId, body), headers);
      return true;
    }
  }

  return false;
}
