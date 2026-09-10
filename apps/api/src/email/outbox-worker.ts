import { config } from "../config.js";
import { callRpc, updateRows } from "../supabase.js";
import { asJsonObject, asNumber, asString, errorMessage, type JsonObject } from "../types.js";

/**
 * Start the periodic email-outbox claim / deliver / complete loop.
 */
export function startEmailOutboxWorker(): ReturnType<typeof setInterval> | null {
  if (!config.supabaseServiceRoleKey || config.emailWorkerIntervalMs <= 0) return null;
  if (!hasEmailProvider()) return null;

  // Reset any emails stuck in 'sending' state from a previous session back to 'pending'
  void updateRows("email_outbox", { status: "eq.sending" }, { status: "pending" })
    .then(() => console.log("[email-outbox] reset stuck 'sending' emails to 'pending'"))
    .catch((err: unknown) => console.error("[email-outbox] failed to reset stuck emails:", errorMessage(err)));

  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const messages = await callRpc("velura_claim_email_outbox", { p_limit: 20 });
      for (const message of Array.isArray(messages) ? messages : []) {
        await deliver(asJsonObject(message));
      }
    } catch (error: unknown) {
      const err = asJsonObject(error);
      console.error("[email-outbox] dispatch cycle failed", {
        code: asString(err.code, "UNKNOWN") || "UNKNOWN",
        status: asNumber(err.status, 500) || 500
      });
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, config.emailWorkerIntervalMs);
  timer.unref?.();
  return timer;
}

async function deliver(message: JsonObject): Promise<void> {
  let success = false;
  let providerError = "";
  try {
    if (hasSmtpProvider()) {
      await deliverWithSmtp(message);
      success = true;
    } else {
      const response = await fetch(config.emailWebhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.emailWebhookToken ? { authorization: `Bearer ${config.emailWebhookToken}` } : {})
        },
        body: JSON.stringify({
          to: message.recipient,
          subject: message.subject,
          text: message.body,
          templateCode: message.template_code,
          metadata: message.metadata || {}
        }),
        signal: AbortSignal.timeout(config.requestTimeoutMs)
      });
      success = response.ok;
      if (!response.ok) providerError = `Provider returned HTTP ${response.status}`;
    }
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : "";
    const messageText = error instanceof Error ? error.message : errorMessage(error);
    providerError = name === "TimeoutError" ? "Email provider timed out" : messageText || "Email provider unavailable";
  }

  await callRpc("velura_complete_email_outbox", {
    p_email_id: message.email_id,
    p_success: success,
    p_error: providerError || null
  });
}

function hasEmailProvider(): boolean {
  return Boolean(config.emailWebhookUrl || hasSmtpProvider());
}

function hasSmtpProvider(): boolean {
  return Boolean(config.smtpHost && config.smtpUser && config.smtpAppPassword);
}

async function deliverWithSmtp(message: JsonObject): Promise<void> {
  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.default.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpAppPassword
    }
  });

  await transporter.sendMail({
    from: config.smtpFrom || `"Velura CSKH" <${config.smtpUser}>`,
    to: typeof message.recipient === "string" ? message.recipient : undefined,
    subject: typeof message.subject === "string" ? message.subject : undefined,
    text: typeof message.body === "string" ? message.body : undefined
  });
}
