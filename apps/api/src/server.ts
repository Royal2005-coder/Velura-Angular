import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { config, assertRuntimeConfig } from "./config.js";
import { applyCors, applySecurityHeaders, getRequestIp, HttpError, parsePathname, readJson, sendError, sendJson, sendNoContent } from "./http.js";
import { completeAdminPasswordSignIn, recordAdminSignOut } from "./auth-signin.js";
import { buildAuthContext, requireAdmin, requireAuthenticated, requirePermission } from "./rbac.js";
import { buildDashboardSummary } from "./dashboard.js";
import { handleDashboardRoute } from "./dashboard-router.js";
import { handleInsightsRoute } from "./insights-router.js";
import { createAccountRepository } from "./accounts/account-repository.js";
import { createAccountService } from "./accounts/account-service.js";
import { handleAccountRoute } from "./accounts/account-router.js";
import { startAccountMaintenance } from "./accounts/account-maintenance.js";
import { startEmailOutboxWorker } from "./email/outbox-worker.js";
import { startPromotionScheduler } from "./pricing/promotion-scheduler.js";
import { createProductRepository } from "./products/product-repository.js";
import { createProductService } from "./products/product-service.js";
import { handleProductRoute } from "./products/product-router.js";
import { createOrderRepository } from "./orders/order-repository.js";
import { createOrderService } from "./orders/order-service.js";
import { startOrderAutomation } from "./orders/order-automation.js";
import { refundStripeOrder } from "./payments/stripe.js";
import { handleOrderRoute } from "./orders/order-router.js";
import { createReviewRepository } from "./reviews/review-repository.js";
import { createReviewService } from "./reviews/review-service.js";
import { handleReviewRoute } from "./reviews/review-router.js";
import { createReturnRepository } from "./returns/return-repository.js";
import { createReturnService } from "./returns/return-service.js";
import { handleReturnRoute } from "./returns/return-router.js";
import { createPricingRepository } from "./pricing/pricing-repository.js";
import { createPricingService } from "./pricing/pricing-service.js";
import { handlePricingRoute } from "./pricing/pricing-router.js";
import { createAuditLogRepository } from "./audit-logs/audit-log-repository.js";
import { createAuditLogService } from "./audit-logs/audit-log-service.js";
import { handleAuditLogRoute } from "./audit-logs/audit-log-router.js";
import { createChatbotRepository } from "./chatbot/chatbot-repository.js";
import { createChatbotService } from "./chatbot/chatbot-service.js";
import { handleChatbotRoute } from "./chatbot/chatbot-router.js";
import { createContentRepository } from "./content/content-repository.js";
import { createContentService } from "./content/content-service.js";
import { handleContentRoute } from "./content/content-router.js";
import { createFixedWindowLimiter } from "./rate-limit.js";
import { handleUserRoute } from "./user/index.js";
import { handleWishlistRoute } from "./v1-wishlist-routes.js";
import { handleRecommendationRoute } from "./recommendation.controller.js";
import { asJsonObject, asString } from "./types.js";
import type { AccountService } from "./accounts/account-service.js";
import type { ProductService } from "./products/product-service.js";

assertRuntimeConfig();

type ChatbotService = ReturnType<typeof createChatbotService>;

const accountService: AccountService = createAccountService({ repository: createAccountRepository() });
const productService: ProductService = createProductService({ repository: createProductRepository() });
const orderService = createOrderService({ repository: createOrderRepository(), refunds: { refund: refundStripeOrder } });
const reviewService = createReviewService({ repository: createReviewRepository() });
const returnService = createReturnService({
  repository: createReturnRepository(),
  refunds: { refund: (orderId, amount) => refundStripeOrder(orderId, { amount }) }
});
const pricingService = createPricingService({ repository: createPricingRepository() });
const auditLogService = createAuditLogService({ repository: createAuditLogRepository() });
const chatbotService: ChatbotService = createChatbotService({ repository: createChatbotRepository() });
const contentService = createContentService({ repository: createContentRepository() });
const mutationLimiter = createFixedWindowLimiter({
  limit: config.adminMutationLimitPerMinute,
  windowMs: 60_000
});
const chatLimiter = createFixedWindowLimiter({
  limit: 30,
  windowMs: 60_000
});
startAccountMaintenance();
startEmailOutboxWorker();
startPromotionScheduler();
startOrderAutomation();

const server = createServer(async (req, res) => {
  const requestId = String(req.headers["x-request-id"] || randomUUID()).slice(0, 128);
  applySecurityHeaders(res, config.nodeEnv);
  res.setHeader("x-request-id", requestId);
  const corsHeaders = applyCors(req, res, config.corsOrigins);

  try {
    if (req.headers.origin && !res.hasHeader("access-control-allow-origin")) {
      for (const [key, value] of Object.entries(corsHeaders)) {
        res.setHeader(key, value);
      }
    }
    if (req.method === "OPTIONS") return sendNoContent(res, corsHeaders);

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const parts = parsePathname(url);

    if (req.method === "GET" && (parts[0] === "health" || (parts[0] === "api" && parts[1] === "health"))) {
      return sendJson(res, 200, {
        ok: true,
        service: "velura-api",
        env: config.nodeEnv,
        time: new Date().toISOString()
      }, corsHeaders);
    }

    if (parts[0] !== "api") {
      throw new HttpError(404, "NOT_FOUND", "Route not found");
    }

    const context = await buildAuthContext(req);

    if (parts[1] === "content") {
      const handled = await handleContentRoute({
        req,
        res,
        url,
        parts,
        headers: corsHeaders,
        service: contentService
      });
      if (handled) return;
    }

    if (req.method === "GET" && parts[1] === "auth" && parts[2] === "google") {
      const redirectTo = url.searchParams.get("redirect_to") || "";
      const challenge = url.searchParams.get("code_challenge") || "";
      if (!redirectTo || !challenge || !config.supabaseUrl) {
        throw new HttpError(400, "BAD_REQUEST", "Missing OAuth parameters");
      }
      const location =
        `${config.supabaseUrl}/auth/v1/authorize?provider=google` +
        `&code_challenge=${encodeURIComponent(challenge)}` +
        `&code_challenge_method=s256` +
        `&redirect_to=${encodeURIComponent(redirectTo)}`;
      res.writeHead(302, { Location: location, ...corsHeaders });
      res.end();
      return;
    }

    if (req.method === "POST" && parts[1] === "auth" && parts[2] === "signin") {
      const body = await readJson(req);
      return sendJson(res, 200, await completeAdminPasswordSignIn(body), corsHeaders);
    }

    if (req.method === "POST" && parts[1] === "auth" && parts[2] === "signout") {
      requireAuthenticated(context);
      await recordAdminSignOut(req, context);
      return sendJson(res, 200, { success: true }, corsHeaders);
    }

    if (req.method === "POST" && parts[1] === "auth" && parts[2] === "recover") {
      const body = await readJson(req);
      const response = await fetch(`${config.supabaseUrl}/auth/v1/recover`, {
        method: "POST",
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${config.supabaseAnonKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ email: body.email })
      });
      if (!response.ok) {
        const payload = asJsonObject(await response.json().catch(() => ({})));
        throw new HttpError(400, "BAD_REQUEST", asString(payload.error_description) || asString(payload.msg) || "Không gửi được email đặt lại mật khẩu.");
      }
      return sendJson(res, 200, { success: true }, corsHeaders);
    }

    if (req.method === "POST" && parts[1] === "auth" && parts[2] === "change-password") {
      if (!context.accessToken || !context.authUser?.email) {
        throw new HttpError(401, "AUTH_REQUIRED", "Cần đăng nhập để đổi mật khẩu.");
      }
      const body = await readJson(req);
      const currentPassword = asString(body.currentPassword);
      const newPassword = asString(body.newPassword);
      if (!currentPassword || !newPassword) {
        throw new HttpError(400, "BAD_REQUEST", "Mật khẩu hiện tại và mật khẩu mới là bắt buộc");
      }
      if (newPassword.length < 12) {
        throw new HttpError(422, "VALIDATION_ERROR", "Mật khẩu mới phải có ít nhất 12 ký tự");
      }
      const verify = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${config.supabaseAnonKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ email: context.authUser.email, password: currentPassword })
      });
      if (!verify.ok) {
        throw new HttpError(401, "UNAUTHORIZED", "Mật khẩu hiện tại không đúng.");
      }
      const updated = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        method: "PUT",
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${context.accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ password: newPassword })
      });
      if (!updated.ok) {
        const payload = asJsonObject(await updated.json().catch(() => ({})));
        throw new HttpError(
          400,
          "BAD_REQUEST",
          asString(payload.error_description) || asString(payload.msg) || "Không đổi được mật khẩu."
        );
      }
      return sendJson(res, 200, { success: true }, corsHeaders);
    }

    if (req.method === "POST" && parts[1] === "auth" && parts[2] === "pkce") {
      const body = await readJson(req);
      const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=pkce`, {
        method: "POST",
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${config.supabaseAnonKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          auth_code: body.auth_code,
          code_verifier: body.code_verifier,
          redirect_uri: body.redirect_uri
        })
      });
      const payload = asJsonObject(await response.json().catch(() => ({})));
      if (!response.ok || !payload.access_token) {
        throw new HttpError(401, "UNAUTHORIZED", asString(payload.error_description) || asString(payload.msg) || "Xác thực thất bại");
      }
      return sendJson(res, 200, { token: payload.access_token }, corsHeaders);
    }

    if (req.method === "GET" && parts[1] === "auth" && parts[2] === "me") {
      return sendJson(res, 200, {
        user: context.authUser ? {
          id: context.authUser.id,
          email: context.authUser.email,
          phone: context.authUser.phone || null
        } : null,
        profile: context.profile,
        role: context.roleCode,
        roleName: context.roleName,
        isAdmin: context.isAdmin,
        allowedPages: context.allowedPages,
        allowedModules: context.allowedModules
      }, corsHeaders);
    }

    if (parts[1] === "user") {
      if (parts[2] === "recommendations" && parts[3] === "style-profile") {
        return await handleRecommendationRoute(req, res, parts, corsHeaders, context);
      }
      return await handleUserRoute(req, res, parts, corsHeaders, context);
    }

    if (parts[1] === "v1" && parts[2] === "wishlists") {
      return await handleWishlistRoute(req, res, parts, corsHeaders, context);
    }

    if (parts[1] === "v1" && parts[2] === "chat") {
      const handled = await handleChatbotRoute({
        req,
        res,
        url,
        parts,
        context,
        headers: corsHeaders,
        service: chatbotService,
        limiter: chatLimiter
      });
      if (handled) return;
    }

    if (parts[1] === "v1" && parts[2] === "admin") {
      requireAdmin(context);
      if (["POST", "PATCH", "DELETE"].includes(req.method || "")) {
        const rate = mutationLimiter.consume(context.authUser?.id || getRequestIp(req));
        res.setHeader("x-ratelimit-remaining", String(rate.remaining));
        res.setHeader("x-ratelimit-reset", String(Math.ceil(rate.resetAt / 1000)));
        if (!rate.allowed) {
          throw new HttpError(429, "RATE_LIMITED", "Too many admin mutation requests");
        }
      }
      const dashboardHandled = await handleDashboardRoute({
        req,
        res,
        url,
        parts,
        context,
        headers: corsHeaders,
        service: {}
      });
      if (dashboardHandled) return;

      const insightsHandled = await handleInsightsRoute({
        req,
        res,
        url,
        parts,
        context,
        headers: corsHeaders,
        service: {}
      });
      if (insightsHandled) return;

      const handled = await handleAccountRoute({
        req,
        res,
        url,
        parts,
        context,
        headers: corsHeaders,
        service: accountService
      });
      if (handled) return;

      const productHandled = await handleProductRoute({
        req,
        res,
        url,
        parts,
        context,
        headers: corsHeaders,
        service: productService
      });
      if (productHandled) return;

      const orderHandled = await handleOrderRoute({
        req,
        res,
        url,
        parts,
        context,
        headers: corsHeaders,
        service: orderService
      });
      if (orderHandled) return;

      const reviewHandled = await handleReviewRoute({
        req,
        res,
        url,
        parts,
        context,
        headers: corsHeaders,
        service: reviewService
      });
      if (reviewHandled) return;

      const returnHandled = await handleReturnRoute({
        req,
        res,
        url,
        parts,
        context,
        headers: corsHeaders,
        service: returnService
      });
      if (returnHandled) return;

      const pricingHandled = await handlePricingRoute({
        req,
        res,
        url,
        parts,
        context,
        headers: corsHeaders,
        service: pricingService
      });
      if (pricingHandled) return;

      const auditLogHandled = await handleAuditLogRoute({
        req, res, url, parts, context, headers: corsHeaders, service: auditLogService
      });
      if (auditLogHandled) return;

      const chatHandled = await handleChatbotRoute({
        req,
        res,
        url,
        parts,
        context,
        headers: corsHeaders,
        service: chatbotService,
        limiter: chatLimiter
      });
      if (chatHandled) return;

      throw new HttpError(404, "NOT_FOUND", "Route not found");
    }

    if (parts[1] !== "admin") {
      throw new HttpError(404, "NOT_FOUND", "Route not found");
    }

    requireAdmin(context);

    if (req.method === "GET" && parts[2] === "dashboard") {
      requirePermission(context, "dashboard", "read");
      return sendJson(res, 200, await buildDashboardSummary(url.searchParams), corsHeaders);
    }

    throw new HttpError(
      410,
      "LEGACY_ADMIN_API_DISABLED",
      "Use a typed versioned endpoint under /api/v1/admin"
    );
  } catch (error) {
    sendError(res, error, corsHeaders, requestId);
  }
});

server.listen(config.port, () => {
  console.log(`Velura API listening on http://localhost:${config.port}`);
});
// Trigger watch restart.
