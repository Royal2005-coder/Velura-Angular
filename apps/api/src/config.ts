export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 8787),
  corsOrigins: parseCsv(process.env.CORS_ORIGIN || "http://localhost:5173"),
  supabaseUrl: stripTrailingSlash(
    process.env.VELURA_SUPABASE_URL || process.env.SUPABASE_URL || "",
  ),
  supabaseAnonKey:
    process.env.VELURA_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "",
  supabaseServiceRoleKey:
    process.env.VELURA_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "",
  requestTimeoutMs: Number(process.env.API_REQUEST_TIMEOUT_MS || 15000),
  maxBodyBytes: Number(process.env.API_MAX_BODY_BYTES || 15728640),
  adminMutationLimitPerMinute: Number(process.env.ADMIN_MUTATION_LIMIT_PER_MINUTE || 60),
  accountMaintenanceIntervalMs: Number(process.env.ACCOUNT_MAINTENANCE_INTERVAL_MS || 3600000),
  emailWorkerIntervalMs: Number(process.env.EMAIL_WORKER_INTERVAL_MS || 60000),
  emailWebhookUrl: process.env.EMAIL_WEBHOOK_URL || "",
  emailWebhookToken: process.env.EMAIL_WEBHOOK_TOKEN || "",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpSecure: process.env.SMTP_SECURE === "true",
  smtpUser: process.env.SMTP_USER || "",
  smtpAppPassword: normalizeAppPassword(process.env.SMTP_APP_PASSWORD || ""),
  smtpFrom: process.env.SMTP_FROM || "",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  apiPublicOrigin: (process.env.API_PUBLIC_ORIGIN || "").replace(/\/+$/, ""),
  vnpayTmnCode: process.env.VNPAY_TMN_CODE || "",
  vnpayHashSecret: process.env.VNPAY_HASH_SECRET || "",
  vnpayPaymentUrl: process.env.VNPAY_PAYMENT_URL || "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
  momoPartnerCode: process.env.MOMO_PARTNER_CODE || "",
  momoAccessKey: process.env.MOMO_ACCESS_KEY || "",
  momoSecretKey: process.env.MOMO_SECRET_KEY || "",
  momoApiOrigin: (process.env.MOMO_API_ORIGIN || "https://test-payment.momo.vn").replace(/\/+$/, ""),
  storefrontOrigin: (process.env.STOREFRONT_ORIGIN || "https://velura.royalai.dev").replace(/\/+$/, ""),
  supportAlertTo: process.env.SUPPORT_ALERT_TO || process.env.SMTP_USER || "",
  n8nChatWebhookUrl: process.env.N8N_CHAT_WEBHOOK_URL || "",
  n8nChatWebhookToken: process.env.N8N_CHAT_WEBHOOK_TOKEN || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2",
  geminiEmbeddingDimensions: Number(process.env.GEMINI_EMBEDDING_DIMENSIONS || 1536),
  geminiStylistModel: process.env.GEMINI_STYLIST_MODEL || "gemini-3.5-flash-lite",
  recommendationMatchThreshold: Number(process.env.RECOMMENDATION_MATCH_THRESHOLD || 0.45),
  recommendationMatchCount: Number(process.env.RECOMMENDATION_MATCH_COUNT || 20),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o",
  geminiModel: process.env.GEMINI_MODEL || process.env.OPENAI_MODEL || "gemini-3.5-flash-lite",
  mistralApiKey: process.env.MISTRAL_API_KEY || "",
  mistralModel: process.env.MISTRAL_MODEL || "mistral-small-latest",
  twilioAccountSid: normalizeTwilioAccountSid(process.env.TWILIO_ACCOUNT_SID || ""),
  twilioApiKeySid: process.env.TWILIO_API_KEY_SID || "",
  twilioApiKeySecret: process.env.TWILIO_API_KEY_SECRET || "",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
  twilioMessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || "",
  smsProvider: (process.env.SMS_PROVIDER || "twilio").trim().toLowerCase(),
  esmsApiKey: process.env.ESMS_API_KEY || "",
  esmsSecretKey: process.env.ESMS_SECRET_KEY || "",
  esmsBrandname: process.env.ESMS_BRANDNAME || "",
  stringeeApiKeySid: process.env.STRINGEE_API_KEY_SID || "",
  stringeeApiKeySecret: process.env.STRINGEE_API_KEY_SECRET || "",
  stringeeBrandname: process.env.STRINGEE_BRANDNAME || "",
  esmsSmsType: process.env.ESMS_SMS_TYPE || "8",
  esmsSandbox: process.env.ESMS_SANDBOX === "1"
};

/**
 * Removes presentation whitespace from provider app passwords.
 * Gmail displays its 16-character app passwords in four groups, while SMTP
 * authentication expects the compact value.
 */
export function normalizeAppPassword(value: string): string {
  return value.replace(/\s+/g, "");
}

/**
 * Accepts either Twilio's full Account SID or the 32 hexadecimal characters
 * copied without its `AC` type prefix.
 */
export function normalizeTwilioAccountSid(value: string): string {
  const trimmed = value.trim();
  if (/^[a-f\d]{32}$/i.test(trimmed)) {
    return `AC${trimmed}`;
  }
  return trimmed;
}

/** Refuse to start with missing data access or a bypassed production AI gateway. */
export function assertRuntimeConfig() {
  const missing: string[] = [];
  if (!config.supabaseUrl) missing.push("VELURA_SUPABASE_URL");
  if (!config.supabaseAnonKey) missing.push("VELURA_SUPABASE_ANON_KEY");
  if (config.nodeEnv === "production") {
    if (!process.env.LITELLM_ENDPOINT) missing.push("LITELLM_ENDPOINT");
    if (!process.env.LITELLM_API_KEY) missing.push("LITELLM_API_KEY");
  }
  if (missing.length) {
    throw new Error(`Missing required API environment: ${missing.join(", ")}`);
  }
}

/** Return the server-only database credential; never expose this value to clients. */
export function getSupabaseServiceKey() {
  return config.supabaseServiceRoleKey;
}

/**
 * Hard-coded OTP shortcuts stay local-only. Production must use the stored code.
 */
export function allowDevOtpBypass(): boolean {
  return config.nodeEnv !== "production";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
