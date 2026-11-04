import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../apps/api/src/http.js";
import {
  newsletterService,
  buildWelcomeEmailHtml,
  buildBlogBroadcastHtml
} from "../../apps/api/src/newsletter/newsletter-service.js";

test("buildWelcomeEmailHtml renders luxury branding and VELURA10 voucher", () => {
  const unsubscribeUrl = "https://api.royalai.dev/api/user/newsletter/unsubscribe?token=abc123token";
  const html = buildWelcomeEmailHtml(unsubscribeUrl);

  assert.match(html, /VELURA/);
  assert.match(html, /VELURA10/);
  assert.match(html, /giảm ngay 10%/i);
  assert.match(html, /abc123token/);
  assert.match(html, /Hủy đăng ký nhận tin/);
});

test("buildBlogBroadcastHtml renders article title, CTA and deep-link", () => {
  const title = "Xu Hướng Thu Đông 2026: Lụa & Len Cashmere";
  const excerpt = "Khám phá phong cách thanh lịch vượt thời gian từ bộ sưu tập mới.";
  const imageUrl = "https://velura.royalai.dev/assets/images/banner.jpg";
  const articleUrl = "https://velura.royalai.dev/blog/xu-huong-thu-dong-2026";
  const unsubscribeUrl = "https://api.royalai.dev/api/user/newsletter/unsubscribe?token=testtoken";

  const html = buildBlogBroadcastHtml(title, excerpt, imageUrl, articleUrl, unsubscribeUrl);

  assert.match(html, /Xu Hướng Thu Đông 2026/);
  assert.match(html, /Khám phá phong cách thanh lịch/);
  assert.match(html, /https:\/\/velura.royalai.dev\/blog\/xu-huong-thu-dong-2026/);
  assert.match(html, /Đọc Bài Viết Trên Velura/);
  assert.match(html, /testtoken/);
});

test("newsletterService.subscribe rejects invalid email formats with 422", async () => {
  await assert.rejects(
    () => newsletterService.subscribe({ email: "invalid-email-format" }),
    (err: unknown) => {
      assert(err instanceof HttpError);
      assert.equal(err.status, 422);
      assert.equal(err.code, "INVALID_EMAIL");
      return true;
    }
  );

  await assert.rejects(
    () => newsletterService.subscribe({ email: "" }),
    (err: unknown) => {
      assert(err instanceof HttpError);
      assert.equal(err.status, 422);
      return true;
    }
  );
});

test("newsletterService.subscribe traps bot submissions with honeypot silently", async () => {
  const result = await newsletterService.subscribe({
    email: "bot@spammer.org",
    honeypot: "http://spam-link.com"
  });

  assert.equal(result.success, true);
  assert.equal(result.isNew, false);
});

test("newsletterService.unsubscribe rejects invalid/short tokens with 400", async () => {
  await assert.rejects(
    () => newsletterService.unsubscribe("short"),
    (err: unknown) => {
      assert(err instanceof HttpError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "INVALID_TOKEN");
      return true;
    }
  );
});
