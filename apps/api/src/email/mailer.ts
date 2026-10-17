import { config } from "../config.js";
import { errorMessage } from "../types.js";

/**
 * Masks an email address for privacy (e.g., "u***@gmail.com").
 */
export function maskEmail(email: string): string {
  if (!email || !email.includes("@")) return email || "";
  const [name, domain] = email.split("@");
  return `${name.slice(0, 1)}***@${domain}`;
}

/**
 * Enforces a timeout on an asynchronous promise.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

/** Optional delivery classification and a stable provider message identifier. */
export interface DirectEmailOptions {
  priority?: "high" | "normal" | "low";
  messageId?: string;
}

/**
 * Sends an email directly via SMTP (nodemailer) without relying on background queue workers.
 * Essential for Serverless (Vercel) environments where persistent background workers do not run.
 *
 * @param to Recipient email address
 * @param subject Email subject
 * @param text Plain text body
 * @param html HTML formatted body
 * @param options Optional priority and stable message identifier
 * @returns True only when SMTP accepts the recipient
 */
export async function sendDirectEmail(
  to: unknown,
  subject: string,
  text: string,
  html: string,
  options: DirectEmailOptions = {}
): Promise<boolean> {
  const recipient = String(to || "").trim();
  if (!recipient || !recipient.includes("@")) {
    return false;
  }

  if (!config.smtpHost || !config.smtpUser || !config.smtpAppPassword) {
    if (config.nodeEnv !== "production") {
      console.log(`[EMAIL MOCK] To: ${recipient} | Subject: ${subject}`);
    } else {
      console.warn(`[EMAIL WARNING] SMTP not configured. Cannot send email to: ${recipient}`);
    }
    return false;
  }

  try {
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.default.createTransport({
      host: config.smtpHost,
      port: config.smtpPort || 587,
      secure: config.smtpSecure === true,
      auth: {
        user: config.smtpUser,
        pass: config.smtpAppPassword
      }
    });

    const sender = config.smtpFrom || `"Velura" <${config.smtpUser}>`;
    const result = await withTimeout(
      transporter.sendMail({
        from: sender,
        to: recipient,
        subject,
        text,
        html,
        priority: options.priority,
        messageId: options.messageId
      }),
      10000,
      "SMTP send"
    );
    const accepted = Array.isArray(result.accepted) && result.accepted.some(
      (address: string | { address: string }) => (
        typeof address === "string" ? address : address.address
      ).toLowerCase() === recipient.toLowerCase()
    );
    if (!accepted) {
      console.warn("[EMAIL WARNING] SMTP did not accept the configured recipient");
      return false;
    }

    console.log(`[EMAIL SENT] Successfully delivered to ${recipient}`);
    return true;
  } catch (err: unknown) {
    console.error(`[EMAIL ERROR] Failed to send email to ${recipient}:`, errorMessage(err));
    return false;
  }
}
