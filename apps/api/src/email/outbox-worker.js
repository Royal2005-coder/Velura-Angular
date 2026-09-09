import { config } from "../config.js";
import { callRpc, updateRows } from "../supabase.js";

export function startEmailOutboxWorker() {
  if (!config.supabaseServiceRoleKey || config.emailWorkerIntervalMs <= 0) return null;
  if (!hasEmailProvider()) return null;

  // Reset any emails stuck in 'sending' state from a previous session back to 'pending'
  void updateRows("email_outbox", { status: "eq.sending" }, { status: "pending" })
    .then(() => console.log("[email-outbox] reset stuck 'sending' emails to 'pending'"))
    .catch((err) => console.error("[email-outbox] failed to reset stuck emails:", err.message));

  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const messages = await callRpc("velura_claim_email_outbox", { p_limit: 20 });
      for (const message of Array.isArray(messages) ? messages : []) {
        await deliver(message);
      }
    } catch (error) {
      console.error("[email-outbox] dispatch cycle failed", {
        code: error.code || "UNKNOWN",
        status: error.status || 500
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

async function deliver(message) {
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
  } catch (error) {
    providerError = error.name === "TimeoutError" ? "Email provider timed out" : error.message || "Email provider unavailable";
  }

  await callRpc("velura_complete_email_outbox", {
    p_email_id: message.email_id,
    p_success: success,
    p_error: providerError || null
  });
}

function hasEmailProvider() {
  return Boolean(config.emailWebhookUrl || hasSmtpProvider());
}

function hasSmtpProvider() {
  return Boolean(config.smtpHost && config.smtpUser && config.smtpAppPassword);
}

async function deliverWithSmtp(message) {
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
    to: message.recipient,
    subject: message.subject,
    text: message.body
  });
}
