import { HttpError, readJson, sendJson } from "../http.js";
import type { AuthContext, HeaderMap, HttpRequest, HttpResponse, JsonObject } from "../types.js";
import { aiOwner } from "../ai/ai-router.js";
import { requirePermission } from "../rbac.js";
import { ShopVisualSearchRepository, VisualCatalogRefresher } from "./visual-search-repository.js";
import { VisualSearchService } from "./visual-search-service.js";
import { uuid } from "./visual-search-types.js";

const service = new VisualSearchService(new ShopVisualSearchRepository());
const refresher = new VisualCatalogRefresher();
/** Read bounded multipart fields without filenames, image URLs, or payloads entering logs/storage. */
export async function readVisualUpload(req: HttpRequest): Promise<{ bytes: Buffer; mime: string; metadata: JsonObject; release(): void }> {
  const contentType = req.headers["content-type"];
  const boundary = typeof contentType === "string" && contentType.match(/^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!boundary || !req[Symbol.asyncIterator]) throw new HttpError(400, "VISUAL_MULTIPART_REQUIRED", "Chọn một ảnh để tìm kiếm.");
  const chunks: Buffer[] = [];
  let size = 0, body: Buffer | undefined;
  try {
    for await (const raw of { [Symbol.asyncIterator]: () => req[Symbol.asyncIterator]!() }) {
      const chunk = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.from(String(raw));
      size += chunk.length;
      if (size > 5 * 1024 * 1024 + 512 * 1024) { chunk.fill(0); throw new HttpError(413, "VISUAL_IMAGE_SIZE", "Ảnh phải có dung lượng không quá 5 MB."); }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
    const marker = Buffer.from(`--${boundary[1] || boundary[2]}`);
    let position = 0, bytes: Buffer | undefined, mime = "", metadata: JsonObject | undefined;
    while (position < body.length) {
      if (!body.subarray(position, position + marker.length).equals(marker)) throw new HttpError(400, "VISUAL_MULTIPART_INVALID", "Không đọc được tệp tải lên.");
      position += marker.length;
      if (body.subarray(position, position + 2).toString() === "--") break;
      if (body.subarray(position, position + 2).toString() !== "\r\n") throw new HttpError(400, "VISUAL_MULTIPART_INVALID", "Không đọc được tệp tải lên.");
      position += 2;
      const endHeaders = body.indexOf("\r\n\r\n", position);
      if (endHeaders < position || endHeaders - position > 4096) throw new HttpError(400, "VISUAL_MULTIPART_INVALID", "Không đọc được tệp tải lên.");
      const headers = body.toString("utf8", position, endHeaders);
      const name = headers.match(/(?:^|;)\s*name="([^"]+)"/i)?.[1];
      position = endHeaders + 4;
      const end = body.indexOf(Buffer.from(`\r\n--${boundary[1] || boundary[2]}`), position);
      if (end < position) throw new HttpError(400, "VISUAL_MULTIPART_INVALID", "Không đọc được tệp tải lên.");
      if (name === "file" && !bytes) {
        bytes = body.subarray(position, end);
        mime = headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1].trim() || "";
      } else if (name === "metadata" && !metadata && end - position <= 500000) {
        const parsed: unknown = JSON.parse(body.toString("utf8", position, end));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as JsonObject;
      } else throw new HttpError(400, "VISUAL_MULTIPART_INVALID", "Chỉ chọn một ảnh và một vùng trang phục.");
      position = end + 2;
    }
    if (!bytes || !metadata) throw new HttpError(400, "VISUAL_MULTIPART_INVALID", "Thiếu ảnh hoặc xác nhận vùng ảnh.");
    const retained = body;
    return { bytes, mime, metadata, release: () => retained.fill(0) };
  } catch (error) {
    body?.fill(0);
    if (error instanceof SyntaxError) throw new HttpError(400, "VISUAL_MULTIPART_INVALID", "Thông tin vùng ảnh chưa hợp lệ.");
    throw error;
  } finally { for (const chunk of chunks) chunk.fill(0); }
}
/** Register before generic /api/user routing. Source upload and matching share one bounded lifecycle. */
export async function handleVisualSearchRoute(req: HttpRequest, res: HttpResponse, parts: string[], headers: HeaderMap, context: AuthContext): Promise<boolean> {
  const user = parts[1] === "user" && parts[2] === "visual-search";
  const admin = parts[1] === "v1" && parts[2] === "admin" && parts[3] === "visual-search" && parts[4] === "refresh" && parts.length === 5;
  if (!user && !admin) return false;
  if (admin) {
    requirePermission(context, "products", "update");
    if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Chỉ hỗ trợ POST.");
    sendJson(res, 200, await refresher.refresh(), { ...headers, "cache-control": "no-store" });
    return true;
  }
  const owner = aiOwner(req, context);
  const memberUserId = context.authUser ? context.profile?.user_id : undefined;
  if (context.authUser && !memberUserId) throw new HttpError(403, "MEMBER_PROFILE_REQUIRED", "Hồ sơ thành viên chưa sẵn sàng.");
  if (parts[3] === "requests" && parts[4] && req.method === "DELETE") {
    if (!uuid(parts[4])) throw new HttpError(400, "VISUAL_REQUEST_INVALID", "Yêu cầu không hợp lệ.");
    service.cancel(owner, parts[4]); sendJson(res, 200, { cancelled: true }, headers); return true;
  }
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Chỉ hỗ trợ POST.");
  service.consume(owner);
  let result;
  if (parts[3] === "refine") {
    const body = await readJson(req, 512 * 1024);
    if (!uuid(String(body.request_id || ""))) throw new HttpError(400, "VISUAL_REQUEST_INVALID", "Yêu cầu không hợp lệ.");
    result = await service.refine(owner, String(body.request_id), body, memberUserId);
  } else if (parts.length === 3) {
    const upload = await readVisualUpload(req);
    try {
      if (upload.metadata.consent !== true || upload.metadata.confirmed !== true) throw new HttpError(400, "CONSENT_REQUIRED", "Xác nhận vùng ảnh và đồng ý xử lý trước khi tìm.");
      if (!uuid(String(upload.metadata.request_id || ""))) throw new HttpError(400, "VISUAL_REQUEST_INVALID", "Yêu cầu không hợp lệ.");
      result = await service.search(owner, String(upload.metadata.request_id), upload.bytes, upload.mime, upload.metadata.filters, memberUserId);
    } finally { upload.release(); }
  } else return false;
  sendJson(res, 200, result, { ...headers, "cache-control": "no-store" });
  return true;
}
