import { resolve } from "node:path";
import { HttpError, readJson, sendJson, getRequestIp } from "../http.js";
import { requirePermission } from "../rbac.js";
import { readMultipartImage } from "../user/upload.js";
import type {
  AuthContext,
  HeaderMap,
  HttpRequest,
  HttpResponse,
} from "../types.js";
import { AiService } from "./ai-service.js";
import { LocalAiRepository } from "./ai-repository.js";
import { ColabAiWorker } from "./colab-worker.js";
import { ShopAiCatalog } from "./ai-catalog.js";

const service = new AiService(
  new LocalAiRepository(
    resolve(process.env.AI_PRIVATE_ROOT || "scratch/ai-private"),
  ),
  new ColabAiWorker(),
  new ShopAiCatalog(),
);
let recovery: Promise<void> | undefined;
const rates = new Map<string, { count: number; expires: number }>();

/** Private AI ownership uses authenticated identity or a high-entropy browser-scoped guest principal. */
export function aiOwner(req: HttpRequest, context: AuthContext): string {
  if (context.authUser) return `member:${context.authUser.id}`;
  if (req.headers.authorization)
    throw new HttpError(401, "AUTH_REQUIRED", "Phiên đăng nhập không hợp lệ.");
  const guest = req.headers["x-guest-session-id"];
  if (
    typeof guest !== "string" ||
    !/^gs_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      guest,
    )
  )
    throw new HttpError(
      401,
      "GUEST_SESSION_REQUIRED",
      "Hãy mở lại phiên trình duyệt.",
    );
  return `guest:${guest}`;
}

/** Route HTTP to the local AI service; no Colab credentials or public image URLs reach the browser. */
export async function handleAiRoute(
  req: HttpRequest,
  res: HttpResponse,
  parts: string[],
  headers: HeaderMap,
  context: AuthContext,
): Promise<boolean> {
  const admin = parts[1] === "ai";
  const user = parts[1] === "user" && parts[2] === "ai";
  if (!admin && !user) return false;
  if (admin)
    requirePermission(
      context,
      "products",
      req.method === "GET" ? "read" : "update",
    );
  const offset = admin ? 2 : 3,
    action = parts[offset];
  if (action === "capabilities" && req.method === "GET") {
    const url = new URL(req.url || "/", "http://localhost");
    const productId = url.searchParams.get("product_id"),
      variantId = url.searchParams.get("variant_id") || undefined;
    sendJson(
      res,
      200,
      {
        ...service.capabilities(),
        ...(productId
          ? await service.productCapabilities(productId, variantId)
          : {}),
      },
      { ...headers, "cache-control": "no-store" },
    );
    return true;
  }
  const owner = aiOwner(req, context);
  if (
    action === "studio" &&
    parts.length === offset + 2 &&
    req.method === "GET"
  ) {
    const image = await service.studioPreview(parts[offset + 1]);
    res.writeHead(200, {
      ...headers,
      "content-type": image.mime,
      "cache-control": "private, no-store",
      "content-disposition": 'inline; filename="studio-preview"',
      "x-content-type-options": "nosniff",
    });
    res.end(image.bytes);
    return true;
  }
  recovery ??= service.recover();
  await recovery;
  if (req.method === "POST") {
    const now = Date.now();
    const keys = [
      { key: owner, limit: 15 },
      { key: `ip:${getRequestIp(req)}`, limit: 30 },
    ];
    for (const { key, limit } of keys) {
      const rate = rates.get(key);
      if (rate && rate.expires > now && rate.count >= limit)
        throw new HttpError(
          429,
          "AI_RATE_LIMIT",
          "Bạn đã gửi nhiều yêu cầu. Vui lòng thử lại sau.",
        );
    }
    for (const { key } of keys) {
      const rate = rates.get(key);
      rates.set(
        key,
        rate && rate.expires > now
          ? { ...rate, count: rate.count + 1 }
          : { count: 1, expires: now + 60_000 },
      );
    }
    if (rates.size > 5000)
      for (const [key, value] of rates)
        if (value.expires <= now) rates.delete(key);
  }
  if (action === "uploads" && req.method === "POST") {
    const image = await readMultipartImage(req);
    sendJson(
      res,
      201,
      await service.upload(owner, image.fileBuffer, image.mimeType),
      headers,
    );
    return true;
  }
  if (
    action === "jobs" &&
    parts.length === offset + 1 &&
    req.method === "POST"
  ) {
    sendJson(
      res,
      202,
      {
        job: await service.create(owner, await readJson(req, 32 * 1024), admin),
      },
      headers,
    );
    return true;
  }
  if (
    action === "jobs" &&
    parts.length === offset + 1 &&
    req.method === "GET"
  ) {
    const url = new URL(req.url || "/", "http://localhost");
    sendJson(
      res,
      200,
      {
        job: await service.getByKey(
          owner,
          url.searchParams.get("idempotency_key") || "",
        ),
      },
      { ...headers, "cache-control": "no-store" },
    );
    return true;
  }
  if (action === "jobs" && parts[offset + 1]) {
    const id = parts[offset + 1];
    if (parts[offset + 2] === "result" && req.method === "GET") {
      const image = await service.result(owner, id);
      res.writeHead(200, {
        ...headers,
        "content-type": "image/png",
        "cache-control": "no-store",
        "content-disposition": 'inline; filename="try-on.png"',
        "x-content-type-options": "nosniff",
      });
      res.end(image);
      return true;
    }
    if (parts.length === offset + 2 && req.method === "GET") {
      sendJson(
        res,
        200,
        { job: await service.get(owner, id) },
        { ...headers, "cache-control": "no-store" },
      );
      return true;
    }
    if (parts.length === offset + 2 && req.method === "DELETE") {
      sendJson(res, 200, { job: await service.cancel(owner, id) }, headers);
      return true;
    }
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found");
}
