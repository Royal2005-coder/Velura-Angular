import { HttpError, sendJson } from "../http.js";
import { handleAuthRoute } from "./auth.js";
import { handleProfileRoute } from "./profile.js";
import { handleProductsRoute } from "./products.js";
import { handleOrdersRoute } from "./order-router.js";
import { CheckoutOtpRateLimiter, CheckoutOtpService, CheckoutService } from "./checkout-service.js";
import { createCheckoutRepository } from "./checkout-repository.js";
import { handleVouchersRoute } from "./vouchers.js";
import { handleReturnsRoute } from "./returns-router.js";
import { handleReviewsRoute } from "./reviews.js";
import { handleQuizRoute } from "./quiz.js";
import { handleWishlistRoute } from "./wishlist.js";
import { handleCartRoute } from "./cart.js";
import { handleNotificationsRoute } from "./notifications.js";
import { handleUploadRoute } from "./upload.js";
import { handleOffersRoute } from "./offers.js";
import { handleCheckoutRoute } from "./checkout-quote.js";
import { handleStripeWebhook } from "../payments/stripe-webhook.js";
import { handleStripeVerify } from "../payments/stripe-verify.js";
import { gatewayEnvironment, handleLocalGatewayIpn, localGatewayConfigured, localGatewaySimulated } from "../payments/local-gateways.js";
import { handleLocalGatewayVerify } from "../payments/local-gateway-verify.js";
import { handleSimulatorApi, handleSimulatorCheckout, handleSimulatorReturn, simulatorReady } from "../payments/gateway-simulator.js";
import { stripeConfigured } from "../payments/stripe.js";
import { requireCustomerOrderAccess } from "./order-access.js";
import { customerPaymentFacts } from "./order-payment-presentation.js";
import { handleNewsletterRoute } from "../newsletter/newsletter-router.js";
import { readJson } from "../http.js";
import { selectOne, selectRows } from "../supabase.js";
import { asString } from "../types.js";
import type { AuthContext, HeaderMap, HttpRequest, HttpResponse } from "../types.js";

const checkoutService = new CheckoutService(createCheckoutRepository());
const checkoutOtpService = new CheckoutOtpService(new CheckoutOtpRateLimiter());

/**
 * Storefront `/api/user/*` dispatcher.
 */
export async function handleUserRoute(
  req: HttpRequest,
  res: HttpResponse,
  parts: string[],
  corsHeaders: HeaderMap,
  context: AuthContext
): Promise<unknown> {
  const subRoute = parts[2]; // e.g. "auth", "profile", "addresses", "style-quiz", "wishlist", "orders", "reviews", "returns", "cart", "categories", "vouchers"
  const action = parts[3];   // e.g. "signup", "signin", or order ID, etc.

  if (subRoute !== "auth" && subRoute !== "newsletter") {
    const authHeader = req.headers.authorization || "";
    if (authHeader && /^Bearer\s+(.+)$/i.test(authHeader) && (!context.authUser || !context.profile)) {
      throw new HttpError(401, "UNAUTHORIZED", "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.");
    }
  }

  switch (subRoute) {
    case "auth":
      return await handleAuthRoute(req, res, action, corsHeaders, context, checkoutService);
      
    case "profile":
    case "addresses":
      return await handleProfileRoute(req, res, subRoute, corsHeaders, context);
      
    case "products":
    case "categories":
      return await handleProductsRoute(req, res, subRoute, action, corsHeaders);
      
    case "orders":
      return await handleOrdersRoute(
        req,
        res,
        subRoute,
        action,
        parts,
        corsHeaders,
        context,
        checkoutService,
        checkoutOtpService
      );

    case "vouchers":
      return await handleVouchersRoute(req, res, action, corsHeaders, context);
      
    case "newsletter":
      return await handleNewsletterRoute(req, res, action, corsHeaders);

    case "checkout":
      return await handleCheckoutRoute(req, res, action, corsHeaders, context);
      
    case "returns":
      return await handleReturnsRoute(req, res, action, parts, corsHeaders, context);
      
    case "reviews":
      return await handleReviewsRoute(req, res, action, parts, corsHeaders, context);
      
    case "style-quiz":
      return await handleQuizRoute(req, res, corsHeaders, context);
      
    case "wishlist":
      return await handleWishlistRoute(req, res, corsHeaders, context);
      
    case "cart":
      return await handleCartRoute(req, res, corsHeaders, context);
      
    case "notifications":
      return await handleNotificationsRoute(req, res, action, parts, corsHeaders, context);

    case "offers":
      return await handleOffersRoute(req, res, corsHeaders, context);

    case "payments":
      if (action === "verify" && req.method === "POST") {
        const body = await readJson(req);
        const identity = asString(body.order_id || body.order_code).trim();
        const order = await selectOne("orders", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity)
          ? {order_id:`eq.${identity}`} : {order_code:`eq.${identity.toUpperCase()}`});
        if (!order) throw new HttpError(404,"NOT_FOUND","Không tìm thấy đơn hàng");
        requireCustomerOrderAccess(order,context,body);
        const {rows} = await selectRows("payment",{order_id:`eq.${order.order_id}`,order:"created_at.desc"});
        const facts = customerPaymentFacts(rows);
        return sendJson(res,200,{success:true,paid:["paid","refund_pending","refunded"].includes(asString(facts.payment_status)),status:facts.payment_status,order_id:order.order_id,order_code:order.order_code,...facts},corsHeaders);
      }
      if (action === "providers" && req.method === "GET") {
        return sendJson(res, 200, { providers: [
          { code: "COD", enabled: true },
          { code: "STRIPE", enabled: stripeConfigured() },
          // environment/simulated đi kèm để storefront ghi nhãn "sandbox" đúng với bản chất phiên,
          // thay vì để khách tưởng đang trả tiền thật.
          ...(["VNPAY", "MOMO"] as const).map(code => {
            const enabled = localGatewayConfigured(code);
            return enabled
              ? { code, enabled, environment: gatewayEnvironment(code), simulated: localGatewaySimulated(code) }
              : { code, enabled, reason: "not_configured" as const };
          })
        ] }, corsHeaders);
      }
      if ((action === "vnpay" || action === "momo") && parts[4] === "ipn") {
        return handleLocalGatewayIpn(req, res, new URL(req.url || "/", "http://localhost"), action === "vnpay" ? "VNPAY" : "MOMO", corsHeaders);
      }
      // Khách tự kiểm tra kết quả sau khi thoát khỏi trang thanh toán rồi quay lại: nhà mạng là
      // nguồn sự thật, không phải query string của trình duyệt.
      if ((action === "vnpay" || action === "momo") && parts[4] === "verify") {
        return handleLocalGatewayVerify(req, res, corsHeaders, context, action === "vnpay" ? "VNPAY" : "MOMO");
      }
      if (action === "simulator") {
        const provider = parts[4] === "vnpay" ? "VNPAY" : parts[4] === "momo" ? "MOMO" : null;
        if (!provider || !simulatorReady(provider)) throw new HttpError(404, "NOT_FOUND", "Route not found");
        if (parts[5] === "checkout") {
          return req.method === "POST"
            ? handleSimulatorReturn(req, res, corsHeaders, provider)
            : handleSimulatorCheckout(req, res, new URL(req.url || "/", `http://${req.headers.host || "localhost"}`), provider, corsHeaders);
        }
        if (parts[5] === "api") {
          return handleSimulatorApi(req, res, new URL(req.url || "/", `http://${req.headers.host || "localhost"}`), provider, corsHeaders);
        }
        throw new HttpError(404, "NOT_FOUND", "Route not found");
      }
      if (action === "stripe" && parts[4] === "webhook") {
        return await handleStripeWebhook(req, res, corsHeaders);
      }
      if (action === "stripe" && parts[4] === "verify") {
        return await handleStripeVerify(req, res, corsHeaders, context);
      }
      throw new HttpError(404, "NOT_FOUND", "Payment route not found");
      
    case "upload":
      return await handleUploadRoute(req, res, corsHeaders, context);
      
    default:
      throw new HttpError(404, "NOT_FOUND", "API endpoint not found");
  }
}
export { requireUserAuth } from "./auth.js";
