import { config } from "../config.js";
import { writeAuditLog } from "../audit.js";
import { getRequestIp, HttpError, sendJson } from "../http.js";
import { errorMessage, type RouteArgs } from "../types.js";
import { gatewayEnvironment, gatewayNotReadyReason, localGatewayConfigured, localGatewaySimulated, realGatewayConfigured, type LocalGateway } from "./local-gateways.js";

/** Booleans only: tells the owner which payment env flags are set, never their values. */
export interface GatewayReadinessReport {
  node_env: string;
  api_public_origin_https: boolean;
  payment_gateway_environment_declared: "sandbox" | "production" | "";
  payment_gateway_simulator_enabled: boolean;
  stripe: { secret_key_set: boolean; webhook_secret_set: boolean };
  providers: Record<Lowercase<LocalGateway>, {
    credentials: Record<string, boolean>;
    real_credentials_complete: boolean;
    environment: "sandbox" | "production";
    simulated: boolean;
    configured: boolean;
    not_ready_reason: string | null;
  }>;
}

/** Snapshot of every precondition behind `localGatewayConfigured`, without exposing any secret value. */
export function buildGatewayReadiness(): GatewayReadinessReport {
  const declared = config.paymentGatewayEnvironment;
  const provider = (code: LocalGateway, credentials: Record<string, boolean>) => ({
    credentials,
    real_credentials_complete: realGatewayConfigured(code),
    environment: gatewayEnvironment(code),
    simulated: localGatewaySimulated(code),
    configured: localGatewayConfigured(code),
    not_ready_reason: gatewayNotReadyReason(code)
  });
  return {
    node_env: config.nodeEnv,
    api_public_origin_https: gatewayNotReadyReason("VNPAY") !== "API_PUBLIC_ORIGIN_NOT_HTTPS",
    payment_gateway_environment_declared: declared === "sandbox" || declared === "production" ? declared : "",
    payment_gateway_simulator_enabled: config.paymentGatewaySimulator,
    stripe: { secret_key_set: Boolean(config.stripeSecretKey), webhook_secret_set: Boolean(config.stripeWebhookSecret) },
    providers: {
      vnpay: provider("VNPAY", { VNPAY_TMN_CODE: Boolean(config.vnpayTmnCode), VNPAY_HASH_SECRET: Boolean(config.vnpayHashSecret), VNPAY_API_URL: Boolean(config.vnpayApiUrl) }),
      momo: provider("MOMO", { MOMO_PARTNER_CODE: Boolean(config.momoPartnerCode), MOMO_ACCESS_KEY: Boolean(config.momoAccessKey), MOMO_SECRET_KEY: Boolean(config.momoSecretKey) })
    }
  };
}

/**
 * `GET /api/v1/admin/payments/gateway-readiness` — super_admin only, the one place that reports
 * why a gateway is not ready. Guests, customers and other admin roles get 403. The response is
 * `no-store` and every read is audited (best-effort: a failed audit write never hides the report).
 */
export async function handleGatewayReadinessRoute({ req, res, parts, context, headers }: RouteArgs<undefined>): Promise<boolean> {
  if (req.method !== "GET" || parts.join("/") !== "api/v1/admin/payments/gateway-readiness") return false;
  if (!context?.isAdmin || context.roleCode !== "super_admin") {
    throw new HttpError(403, "FORBIDDEN", "Chỉ super_admin được xem tình trạng cổng thanh toán.");
  }
  const report = buildGatewayReadiness();
  await writeAuditLog({
    actor_id: context.profile?.user_id ?? context.authUser?.id ?? null,
    actor_role: context.roleCode,
    action: "view_gateway_readiness",
    module: "payments",
    new_value: { simulator_enabled: report.payment_gateway_simulator_enabled },
    ip_address: getRequestIp(req)
  }).catch((error: unknown) => console.error("[audit] payments gateway-readiness write failed", errorMessage(error)));
  sendJson(res, 200, report, { ...headers, "cache-control": "no-store" });
  return true;
}
