import { readJson, sendJson, HttpError, getRequestIp } from "../http.js";
import { asString, type HeaderMap, type HttpRequest, type HttpResponse } from "../types.js";
import { newsletterService } from "./newsletter-service.js";

/**
 * Dispatches `/api/user/newsletter/*` endpoints.
 */
export async function handleNewsletterRoute(
  req: HttpRequest,
  res: HttpResponse,
  action: string | undefined,
  corsHeaders: HeaderMap
): Promise<unknown> {
  const method = req.method?.toUpperCase();

  // POST /api/user/newsletter/subscribe
  if (action === "subscribe" && method === "POST") {
    const body = (await readJson(req)) || {};
    const email = asString(body.email);
    const source = asString(body.source) || "storefront_footer";
    const honeypot = asString(body.hp_website || body.honeypot);

    const clientIp = getRequestIp(req);

    const result = await newsletterService.subscribe({
      email,
      source,
      honeypot,
      ipAddress: clientIp
    });

    return sendJson(res, 200, result, corsHeaders);
  }

  // GET /api/user/newsletter/unsubscribe?token=...
  if (action === "unsubscribe" && method === "GET") {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const token = url.searchParams.get("token") || "";

    const result = await newsletterService.unsubscribe(token);
    
    // Return accessible HTML page or JSON
    const acceptsHtml = (req.headers.accept || "").includes("text/html");
    if (acceptsHtml) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        ...corsHeaders
      });
      res.end(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hủy Đăng Ký Bản Tin — Velura</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #FAF5F7; color: #2A2522; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { background: #fff; max-width: 480px; width: 100%; border-radius: 16px; border: 1px solid #EAD7DD; padding: 36px 28px; text-align: center; box-shadow: 0 10px 30px rgba(122, 40, 60, 0.08); }
    h1 { color: #7A283C; font-size: 22px; margin: 0 0 12px; }
    p { font-size: 15px; color: #4A4044; line-height: 1.6; margin: 0 0 24px; }
    a { display: inline-block; background: #7A283C; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 999px; font-weight: 600; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${result.success ? "Đã Hủy Đăng Ký Bản Tin" : "Thông Báo"}</h1>
    <p>${result.message}</p>
    <a href="https://velura.royalai.dev">Quay Lại Trang Chủ Velura</a>
  </div>
</body>
</html>`);
      return;
    }

    return sendJson(res, 200, result, corsHeaders);
  }

  throw new HttpError(404, "NOT_FOUND", "Endpoint không tồn tại.");
}
