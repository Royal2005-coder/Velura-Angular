import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { HttpError } from "../http.js";
import { insertRow, selectOne, selectRows, updateRows } from "../supabase.js";
import { asJsonObject, asString, errorMessage, type JsonObject } from "../types.js";
import { sendDirectEmail } from "../email/mailer.js";

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const VOUCHER_CODE = "VELURA10";
const RATE_LIMIT_WINDOW_MS = 60000;
const MAX_REQUESTS_PER_WINDOW = 5;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

/**
 * Cleanup expired rate limit entries periodically.
 */
function cleanupRateLimits(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (entry.resetAt <= now) {
      rateLimitMap.delete(key);
    }
  }
}

/**
 * Checks in-memory sliding window rate limit for an identifier (e.g. IP or email).
 */
function checkRateLimit(key: string): boolean {
  cleanupRateLimits();
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || entry.resetAt <= now) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  entry.count += 1;
  return true;
}

export interface SubscribeInput {
  email: string;
  source?: string;
  honeypot?: string;
  ipAddress?: string;
}

export interface SubscribeResult {
  success: boolean;
  message: string;
  isNew: boolean;
}

export interface BroadcastBlogInput {
  blogId: string;
  slug: string;
  title: string;
  excerpt?: string | null;
  imageUrl?: string | null;
  author?: string | null;
}

/**
 * Builds responsive luxury HTML for welcome newsletter with 10% voucher.
 */
export function buildWelcomeEmailHtml(unsubscribeUrl: string): string {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chào mừng bạn đến với Velura</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FAF5F7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #2A2522;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FAF5F7; padding: 24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 600px; background-color: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(122, 40, 60, 0.08); border: 1px solid #EAD7DD;">
          <!-- Header Banner -->
          <tr>
            <td style="background: linear-gradient(135deg, #7A283C 0%, #C94F70 100%); padding: 36px 24px; text-align: center;">
              <h1 style="margin: 0; color: #FFFFFF; font-size: 28px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;">VELURA</h1>
              <p style="margin: 8px 0 0; color: #FBEFF3; font-size: 14px; font-weight: 400; letter-spacing: 0.04em;">Thời Trang Thông Minh Cho Phái Đẹp Hiện Đại</p>
            </td>
          </tr>
          <!-- Body Content -->
          <tr>
            <td style="padding: 32px 28px;">
              <h2 style="margin: 0 0 16px; color: #7A283C; font-size: 20px; font-weight: 600;">Chào mừng quý cô đến với Velura!</h2>
              <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.6; color: #4A4044;">
                Cảm ơn bạn đã đăng ký nhận bản tin thời trang từ Velura. Chúng tôi rất hân hạnh được đồng hành cùng phong cách thanh lịch, tinh tế và tự tin của bạn.
              </p>
              
              <!-- Voucher Box -->
              <div style="background-color: #FBEFF3; border: 2px dashed #C94F70; border-radius: 12px; padding: 20px; text-align: center; margin: 24px 0;">
                <p style="margin: 0 0 8px; font-size: 13px; font-weight: 600; color: #7A283C; text-transform: uppercase; letter-spacing: 0.05em;">Món quà đặc quyền chào mừng</p>
                <div style="font-size: 26px; font-weight: 800; color: #7A283C; letter-spacing: 0.15em; margin: 8px 0;">${VOUCHER_CODE}</div>
                <p style="margin: 0; font-size: 14px; color: #6A5057; font-weight: 500;">
                  Ưu đãi <strong>giảm ngay 10%</strong> (tối đa 100.000₫) cho đơn hàng từ 100.000₫.
                </p>
              </div>

              <!-- CTA Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 28px auto 0;">
                <tr>
                  <td style="border-radius: 999px; background-color: #7A283C; text-align: center;">
                    <a href="https://velura.royalai.dev/products" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 15px; font-weight: 600; color: #FFFFFF; text-decoration: none; border-radius: 999px;">
                      Khám Phá Bộ Sưu Tập Ngay
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #FAF5F7; padding: 20px 24px; text-align: center; border-top: 1px solid #EAD7DD; font-size: 12px; color: #8A7B80; line-height: 1.5;">
              <p style="margin: 0 0 8px;">Bạn nhận được email này vì đã đăng ký nhận bản tin thời trang tại Velura.</p>
              <p style="margin: 0;">
                <a href="${unsubscribeUrl}" style="color: #7A283C; text-decoration: underline;">Hủy đăng ký nhận tin</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Builds responsive luxury HTML for automated blog newsletter broadcasts.
 */
export function buildBlogBroadcastHtml(
  title: string,
  excerpt: string,
  imageUrl: string,
  articleUrl: string,
  unsubscribeUrl: string
): string {
  const safeImage = imageUrl || "https://velura.royalai.dev/assets/images/logo.png";
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FAF5F7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #2A2522;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FAF5F7; padding: 24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 600px; background-color: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(122, 40, 60, 0.08); border: 1px solid #EAD7DD;">
          <!-- Header Banner -->
          <tr>
            <td style="background: linear-gradient(135deg, #7A283C 0%, #C94F70 100%); padding: 24px; text-align: center;">
              <h1 style="margin: 0; color: #FFFFFF; font-size: 24px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;">VELURA BLOG</h1>
              <p style="margin: 6px 0 0; color: #FBEFF3; font-size: 13px; font-weight: 400;">Bản Tin Thời Trang &amp; Phong Cách Phái Đẹp</p>
            </td>
          </tr>
          <!-- Cover Image -->
          <tr>
            <td style="padding: 0;">
              <a href="${articleUrl}" target="_blank">
                <img src="${safeImage}" alt="${title}" width="600" style="display: block; width: 100%; max-height: 320px; object-fit: cover; border: 0;" />
              </a>
            </td>
          </tr>
          <!-- Article Details -->
          <tr>
            <td style="padding: 28px 24px;">
              <h2 style="margin: 0 0 12px; color: #7A283C; font-size: 20px; font-weight: 700; line-height: 1.4;">
                <a href="${articleUrl}" target="_blank" style="color: #7A283C; text-decoration: none;">${title}</a>
              </h2>
              <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: #4A4044;">
                ${excerpt}
              </p>
              
              <!-- CTA Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 999px; background-color: #7A283C; text-align: center;">
                    <a href="${articleUrl}" target="_blank" style="display: inline-block; padding: 12px 28px; font-size: 14px; font-weight: 600; color: #FFFFFF; text-decoration: none; border-radius: 999px;">
                      Đọc Bài Viết Trên Velura &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #FAF5F7; padding: 20px 24px; text-align: center; border-top: 1px solid #EAD7DD; font-size: 12px; color: #8A7B80; line-height: 1.5;">
              <p style="margin: 0 0 8px;">Bạn nhận được bản tin này vì đã đăng ký nhận tin tại Velura.</p>
              <p style="margin: 0;">
                <a href="${unsubscribeUrl}" style="color: #7A283C; text-decoration: underline;">Hủy đăng ký nhận tin</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Service managing newsletter subscriber lifecycle and automated marketing broadcasts.
 */
export class NewsletterService {
  /**
   * Registers a customer email for fashion newsletters and sends an instant 10% voucher email.
   */
  async subscribe(input: SubscribeInput): Promise<SubscribeResult> {
    // 1. Honeypot check for bots
    if (input.honeypot && String(input.honeypot).trim().length > 0) {
      return {
        success: true,
        message: "Đăng ký nhận tin thành công! Mã ưu đãi 10% đã được gửi tới email của bạn.",
        isNew: false
      };
    }

    // 2. Email format validation
    const rawEmail = String(input.email || "").trim().toLowerCase();
    if (!rawEmail || !EMAIL_REGEX.test(rawEmail) || rawEmail.length > 255) {
      throw new HttpError(422, "INVALID_EMAIL", "Vui lòng nhập địa chỉ email hợp lệ.");
    }

    // 3. Rate limiting by IP or email
    const rateLimitKey = input.ipAddress ? `ip:${input.ipAddress}` : `email:${rawEmail}`;
    if (!checkRateLimit(rateLimitKey)) {
      throw new HttpError(429, "RATE_LIMITED", "Bạn thao tác quá nhanh. Vui lòng thử lại sau giây lát.");
    }

    // 4. Persistence & Deduplication
    let isNew = false;
    let token = randomBytes(24).toString("hex");

    try {
      const existing = await selectOne("newsletter_subscribers", {
        email: `eq.${rawEmail}`,
        select: "subscriber_id,status,unsubscribe_token"
      });

      if (existing) {
        token = asString(existing.unsubscribe_token) || token;
        if (existing.status === "active") {
          return {
            success: true,
            message: "Email này đã đăng ký nhận tin từ trước! Mã ưu đãi VELURA10 luôn sẵn sàng cho bạn.",
            isNew: false
          };
        }
        // Reactivate unsubscribed user
        await updateRows(
          "newsletter_subscribers",
          { subscriber_id: `eq.${existing.subscriber_id}` },
          {
            status: "active",
            unsubscribed_at: null,
            subscribed_at: new Date().toISOString(),
            source: input.source || "storefront_footer"
          }
        );
      } else {
        isNew = true;
        await insertRow("newsletter_subscribers", {
          email: rawEmail,
          status: "active",
          source: input.source || "storefront_footer",
          unsubscribe_token: token,
          metadata: { ip_address: input.ipAddress || null }
        });
      }
    } catch (err: unknown) {
      console.warn("[NEWSLETTER_SUBSCRIBE] Database operation fallback:", errorMessage(err));
    }

    // 5. Dispatch Welcome 10% Voucher Email
    const baseUrl = config.nodeEnv === "production" ? "https://api.royalai.dev" : `http://127.0.0.1:${config.port}`;
    const unsubscribeUrl = `${baseUrl}/api/user/newsletter/unsubscribe?token=${token}`;
    const emailSubject = "Chào mừng bạn đến với Velura — Nhận ưu đãi 10% cho đơn hàng đầu tiên";
    const plainText = `Chào mừng bạn đến với Velura! Cảm ơn bạn đã đăng ký nhận bản tin thời trang. Mã ưu đãi 10% của bạn là: ${VOUCHER_CODE} (Áp dụng cho đơn từ 100.000đ). Hủy đăng ký tại: ${unsubscribeUrl}`;
    const html = buildWelcomeEmailHtml(unsubscribeUrl);

    try {
      await sendDirectEmail(rawEmail, emailSubject, plainText, html, { priority: "high" });
    } catch (err: unknown) {
      console.error("[NEWSLETTER_EMAIL] Failed to send welcome email:", errorMessage(err));
    }

    // Also record audit entry in email_outbox with priority 50
    try {
      await insertRow("email_outbox", {
        recipient: rawEmail,
        template_code: "newsletter_welcome_10pct",
        subject: emailSubject,
        body: plainText,
        html_body: html,
        priority: 50,
        status: "sent",
        metadata: { voucher_code: VOUCHER_CODE, unsubscribe_url: unsubscribeUrl }
      });
    } catch {
      // Ignored non-fatal audit log failure
    }

    return {
      success: true,
      message: "Đăng ký nhận tin thành công! Mã ưu đãi 10% đã được gửi tới email của bạn.",
      isNew
    };
  }

  /**
   * Unsubscribes an audience member via secure unguessable token.
   */
  async unsubscribe(token: string): Promise<{ success: boolean; message: string }> {
    const rawToken = String(token || "").trim();
    if (!rawToken || rawToken.length < 16) {
      throw new HttpError(400, "INVALID_TOKEN", "Mã hủy đăng ký không hợp lệ.");
    }

    const subscriber = await selectOne("newsletter_subscribers", {
      unsubscribe_token: `eq.${rawToken}`,
      select: "subscriber_id,email,status"
    });

    if (!subscriber) {
      return {
        success: false,
        message: "Không tìm thấy thông tin đăng ký hoặc liên kết đã hết hạn."
      };
    }

    if (subscriber.status === "unsubscribed") {
      return {
        success: true,
        message: "Bạn đã hủy đăng ký nhận bản tin thành công từ trước."
      };
    }

    await updateRows(
      "newsletter_subscribers",
      { subscriber_id: `eq.${subscriber.subscriber_id}` },
      {
        status: "unsubscribed",
        unsubscribed_at: new Date().toISOString()
      }
    );

    return {
      success: true,
      message: "Bạn đã hủy đăng ký nhận bản tin thời trang Velura thành công."
    };
  }

  /**
   * Broadcasts a newly published blog article to all active newsletter subscribers.
   */
  async broadcastBlog(blog: BroadcastBlogInput): Promise<{ queuedCount: number }> {
    const blogId = String(blog.blogId || "").trim();
    if (!blogId) return { queuedCount: 0 };

    // 1. Fetch active subscribers
    let subscribers: JsonObject[] = [];
    try {
      const res = await selectRows("newsletter_subscribers", {
        status: "eq.active",
        select: "subscriber_id,email,unsubscribe_token",
        limit: 50000
      });
      subscribers = res.rows || [];
    } catch (err: unknown) {
      console.warn("[BLOG_BROADCAST] Could not load subscribers:", errorMessage(err));
      return { queuedCount: 0 };
    }

    if (!subscribers.length) {
      return { queuedCount: 0 };
    }

    const apiBaseUrl = config.nodeEnv === "production" ? "https://api.royalai.dev" : `http://127.0.0.1:${config.port}`;
    const storefrontBaseUrl = "https://velura.royalai.dev";
    const articleUrl = `${storefrontBaseUrl}/blog/${blog.slug}`;
    const subject = `[Velura Fashion] ${blog.title}`;
    const excerpt = blog.excerpt || "Khám phá xu hướng thời trang và phong cách mới nhất cùng Velura.";
    const imageUrl = blog.imageUrl || "";

    let queuedCount = 0;
    for (const sub of subscribers) {
      const email = asString(sub.email).trim().toLowerCase();
      if (!email || !EMAIL_REGEX.test(email)) continue;

      const token = asString(sub.unsubscribe_token);
      const unsubscribeUrl = `${apiBaseUrl}/api/user/newsletter/unsubscribe?token=${token}`;
      const plainText = `Bản tin thời trang Velura: ${blog.title}\n\n${excerpt}\n\nXem chi tiết tại: ${articleUrl}\n\nHủy đăng ký nhận tin: ${unsubscribeUrl}`;
      const html = buildBlogBroadcastHtml(blog.title, excerpt, imageUrl, articleUrl, unsubscribeUrl);

      try {
        await insertRow("email_outbox", {
          recipient: email,
          template_code: "newsletter_blog_broadcast",
          subject,
          body: plainText,
          html_body: html,
          priority: 10, // Lowest priority to prevent Head-of-Line starvation of transactional emails
          status: "pending",
          metadata: {
            blog_id: blogId,
            slug: blog.slug,
            unsubscribe_url: unsubscribeUrl
          }
        });
        queuedCount += 1;
      } catch (err: unknown) {
        console.warn(`[BLOG_BROADCAST] Failed to queue email for ${email}:`, errorMessage(err));
      }
    }

    // 2. Mark blog as broadcasted to prevent duplicate blasts on subsequent minor edits
    try {
      await updateRows("blog", { blog_id: `eq.${blogId}` }, { newsletter_broadcast_at: new Date().toISOString() });
    } catch (err: unknown) {
      console.warn("[BLOG_BROADCAST] Failed to stamp newsletter_broadcast_at on blog:", errorMessage(err));
    }

    return { queuedCount };
  }
}

export const newsletterService = new NewsletterService();
