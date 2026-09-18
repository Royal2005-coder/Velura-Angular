import { config } from "../config.js";
import { getRequestIp, HttpError, readJson, sendJson } from "../http.js";
import type { RouteArgs } from "../types.js";
import { readMultipartImage, uploadToSupabaseStorage } from "../user/upload.js";
import { PROMOTION_BANNER_STORAGE, PROMOTION_OPERATOR_ROLES } from "./pricing-constants.js";
import type { PricingService } from "./pricing-service.js";

/**
 * Admin pricing HTTP routes under `/api/v1/admin`.
 */
export async function handlePricingRoute({ req, res, url, parts, context, headers, service }: RouteArgs<PricingService>): Promise<boolean> {
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "admin") return false;

  if (parts[3] === "pricing") {
    if (req.method === "GET" && parts[4] === "history" && parts.length === 5) {
      sendJson(res, 200, await service.listPriceHistory(context, url.searchParams), headers);
      return true;
    }
    if (req.method === "GET" && parts[4] === "audit-logs" && parts.length === 5) {
      sendJson(res, 200, await service.listAuditLogs(context, url.searchParams), headers);
      return true;
    }
    if (req.method === "GET" && parts[4] === "statistics" && parts.length === 5) {
      sendJson(res, 200, await service.getStatistics(context), headers);
      return true;
    }
    return false;
  }

  if (parts[3] === "promotions") {
    if (req.method === "GET" && parts.length === 4) {
      sendJson(res, 200, await service.listPromotions(context, url.searchParams), headers);
      return true;
    }
    if (req.method === "POST" && parts.length === 4) {
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 201, await service.createPromotion(context, body), headers);
      return true;
    }
    // Tải ảnh banner chiến dịch. Đặt trước nhánh :promoId vì promo_id là uuid nên không
    // thể trùng với "banner". Chốt quyền kiểm ngay tại đây: tuyến tải ảnh của khách
    // (/api/user/upload/evidence) không yêu cầu đăng nhập, không lấy đó làm mẫu.
    if (req.method === "POST" && parts[4] === "banner" && parts.length === 5) {
      if (!context?.authUser?.id) {
        throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
      }
      if (!PROMOTION_OPERATOR_ROLES.includes(context.roleCode)) {
        throw new HttpError(403, "RBAC_DENIED", "Chỉ người vận hành giá & khuyến mãi mới được tải ảnh chiến dịch.");
      }
      const image = await readMultipartImage(req);
      const url = await uploadToSupabaseStorage(image.fileBuffer, image.fileName, image.mimeType, PROMOTION_BANNER_STORAGE);
      sendJson(res, 200, { url }, headers);
      return true;
    }
    const promoId = parts[4];
    if (promoId && parts.length === 5) {
      if (req.method === "GET") {
        sendJson(res, 200, await service.getPromotion(context, promoId), headers);
        return true;
      }
      if (req.method === "PATCH") {
        const body = await readJson(req, config.maxBodyBytes);
        sendJson(res, 200, await service.updatePromotion(context, promoId, body), headers);
        return true;
      }
    }
    if (parts[5] === "activate" && parts.length === 6 && req.method === "POST") {
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.activatePromotion(context, parts[4], body), headers);
      return true;
    }
    if (parts[5] === "pause" && parts.length === 6 && req.method === "POST") {
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.pausePromotion(context, parts[4], body), headers);
      return true;
    }
  }

  if (parts[3] === "vouchers") {
    if (req.method === "GET" && parts.length === 4) {
      sendJson(res, 200, await service.listVouchers(context, url.searchParams), headers);
      return true;
    }
    if (req.method === "POST" && parts.length === 4) {
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 201, await service.createVoucher(context, body), headers);
      return true;
    }
    const voucherId = parts[4];
    if (voucherId && parts.length === 5 && req.method === "GET") {
      sendJson(res, 200, await service.getVoucher(context, voucherId), headers);
      return true;
    }
    if (voucherId && parts.length === 5 && req.method === "PATCH") {
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.updateVoucher(context, voucherId, body), headers);
      return true;
    }
    if (voucherId && parts[5] === "toggle" && parts.length === 6 && req.method === "POST") {
      sendJson(res, 200, await service.toggleVoucher(context, voucherId), headers);
      return true;
    }
  }

  if (parts[3] === "products" && parts.length === 6 && parts[5] === "change-price" && req.method === "POST") {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.changePrice(context, parts[4], body), headers);
    return true;
  }

  return false;
}
