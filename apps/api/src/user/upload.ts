import { config } from "../config.js";
import { HttpError, sendJson } from "../http.js";
import { requireUserAuth } from "./auth.js";
import {
  asJsonObject,
  asString,
  type AuthContext,
  type HeaderMap,
  type HttpRequest,
  type HttpResponse
} from "../types.js";

const STORAGE_BUCKET = "return-evidence";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/** Nơi cất tệp: kho chứa và thư mục con bên trong kho. */
export interface StorageTarget {
  bucket: string;
  prefix: string;
}

const EVIDENCE_TARGET: StorageTarget = { bucket: STORAGE_BUCKET, prefix: "evidence" };

/**
 * Upload a single image file buffer to Supabase Storage.
 * Returns the public URL.
 */
export async function uploadToSupabaseStorage(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  target: StorageTarget = EVIDENCE_TARGET
): Promise<string> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new HttpError(503, "STORAGE_NOT_CONFIGURED", "Supabase Storage is not configured");
  }

  // Sanitize filename
  const ext = filename.split(".").pop()?.toLowerCase() || "jpg";
  const uniqueName = `${target.prefix}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const uploadUrl = `${config.supabaseUrl}/storage/v1/object/${target.bucket}/${uniqueName}`;

  console.log(`[UPLOAD] Uploading to Supabase Storage: ${uploadUrl} (${buffer.length} bytes, ${mimeType})`);

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "apikey": config.supabaseAnonKey,
      "authorization": `Bearer ${config.supabaseAnonKey}`,
      "content-type": mimeType,
      "x-upsert": "true"
    },
    body: buffer
  });

  const responseText = await response.text();
  console.log(`[UPLOAD] Supabase response ${response.status}:`, responseText.slice(0, 500));

  if (!response.ok) {
    let errMsg = "Failed to upload to storage";
    try {
      const errData = asJsonObject(JSON.parse(responseText) as unknown);
      errMsg = asString(errData.error) || asString(errData.message) || errMsg;
    } catch {
      // keep default message
    }
    console.error(`[UPLOAD ERROR] Supabase Storage returned ${response.status}: ${errMsg}`);
    console.error(`[UPLOAD ERROR] Bucket '${target.bucket}' may not exist or missing upload policy.`);
    throw new HttpError(502, "STORAGE_UPLOAD_FAILED", `Supabase Storage: ${errMsg}`);
  }

  // Public URL format for Supabase Storage
  const publicUrl = `${config.supabaseUrl}/storage/v1/object/public/${target.bucket}/${uniqueName}`;
  return publicUrl;
}

/** Tệp ảnh đã đọc xong từ thân yêu cầu multipart. */
export interface UploadedImage {
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
}

/**
 * Đọc một ảnh từ thân yêu cầu multipart/form-data và kiểm tra kích thước, kiểu tệp.
 *
 * Tách ra khỏi `handleUploadRoute` để các tuyến khác dùng lại được phần đọc tệp mà
 * vẫn tự đặt chốt quyền của riêng mình — tuyến bằng chứng đổi trả không yêu cầu đăng
 * nhập, còn tuyến tải ảnh banner thì chỉ dành cho người vận hành khuyến mãi.
 */
export async function readMultipartImage(req: HttpRequest): Promise<UploadedImage> {
  const contentType = req.headers["content-type"] || "";
  const contentTypeText = Array.isArray(contentType) ? contentType.join(",") : contentType;
  if (!contentTypeText.includes("multipart/form-data")) {
    throw new HttpError(400, "BAD_REQUEST", "Content-Type must be multipart/form-data");
  }

  const boundaryMatch = contentTypeText.match(/boundary=([^\s;]+)/i);
  if (!boundaryMatch) {
    throw new HttpError(400, "BAD_REQUEST", "Missing multipart boundary in Content-Type");
  }
  const boundary = boundaryMatch[1].replace(/^"|"$/g, "");

  const chunks: Buffer[] = [];
  let totalSize = 0;
  const iterator = req[Symbol.asyncIterator];
  if (typeof iterator !== "function") {
    throw new TypeError("Request is not async iterable");
  }
  for await (const chunk of { [Symbol.asyncIterator]: () => iterator.call(req) } as AsyncIterable<unknown>) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : Buffer.from(String(chunk));
    totalSize += buffer.length;
    if (totalSize > MAX_FILE_SIZE + 8192) {
      throw new HttpError(413, "FILE_TOO_LARGE", "File exceeds 5 MB limit");
    }
    chunks.push(buffer);
  }

  const { fileBuffer, fileName, mimeType } = parseMultipartFile(Buffer.concat(chunks), boundary);
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new HttpError(400, "BAD_REQUEST", "No file found in the request body");
  }
  if (!ALLOWED_TYPES.includes(mimeType)) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE",
      `File type '${mimeType}' is not allowed. Accepted: JPG, PNG, WebP, GIF`);
  }
  return { fileBuffer, fileName, mimeType };
}

/**
 * POST /api/user/upload/evidence
 * Accepts multipart/form-data with a single "file" field.
 * Returns { success: true, url: "https://..." }
 *
 * Tuyến này trước đây không nhận `context` và không kiểm tra gì cả: bất kỳ ai biết
 * đường dẫn đều ghi được tệp 5 MB vào kho `return-evidence` với đường dẫn công khai,
 * không giới hạn số lần và không truy được ai đã tải. Kho này chứa ảnh bằng chứng đổi
 * trả của khách, nên nó phải đứng sau đăng nhập như mọi tuyến `/api/user/*` khác.
 */
export async function handleUploadRoute(
  req: HttpRequest,
  res: HttpResponse,
  corsHeaders: HeaderMap,
  context: AuthContext
): Promise<void> {
  if (req.method !== "POST") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST is accepted");
  }

  const profile = requireUserAuth(context);

  const { fileBuffer, fileName, mimeType } = await readMultipartImage(req);

  // Thư mục con theo người tải, để một tệp bất thường còn truy được về chủ của nó.
  const publicUrl = await uploadToSupabaseStorage(fileBuffer, fileName, mimeType, {
    bucket: EVIDENCE_TARGET.bucket,
    prefix: `${EVIDENCE_TARGET.prefix}/${profile.user_id}`
  });
  return sendJson(res, 200, { success: true, url: publicUrl }, corsHeaders);
}

/**
 * Parse a multipart/form-data body and return the first file part found.
 */
function parseMultipartFile(
  body: Buffer,
  boundary: string
): { fileBuffer: Buffer | null; fileName: string; mimeType: string } {
  const delimiterLine = Buffer.from(`--${boundary}`);

  let fileBuffer: Buffer | null = null;
  let fileName = "upload.jpg";
  let mimeType = "image/jpeg";

  // Split body on the boundary delimiter lines
  let pos = 0;

  while (pos < body.length) {
    // Find the next boundary
    const boundaryPos = indexOfBuf(body, delimiterLine, pos);
    if (boundaryPos === -1) break;

    // Move past the boundary + CRLF
    pos = boundaryPos + delimiterLine.length;

    // Check if this is the final boundary
    if (body[pos] === 45 && body[pos + 1] === 45) break; // "--"

    // Skip the CRLF after boundary
    if (body[pos] === 13 && body[pos + 1] === 10) pos += 2;

    // Find the blank line separating headers from content (CRLFCRLF)
    const headersEnd = indexOfBuf(body, Buffer.from("\r\n\r\n"), pos);
    if (headersEnd === -1) break;

    const headerBlock = body.slice(pos, headersEnd).toString("utf8");
    pos = headersEnd + 4; // skip CRLFCRLF

    // Only process parts that have a filename (i.e., file fields)
    if (!headerBlock.includes("filename=")) continue;

    // Extract filename
    const fnMatch = headerBlock.match(/filename="([^"]+)"/i);
    if (fnMatch) fileName = fnMatch[1];

    // Extract Content-Type from headers
    const ctMatch = headerBlock.match(/Content-Type:\s*([^\r\n]+)/i);
    if (ctMatch) mimeType = ctMatch[1].trim();

    // Content ends at the next boundary (preceded by CRLF)
    const nextBoundary = indexOfBuf(body, Buffer.from(`\r\n--${boundary}`), pos);
    if (nextBoundary === -1) {
      // Rest of body is the file
      fileBuffer = body.slice(pos);
    } else {
      fileBuffer = body.slice(pos, nextBoundary);
    }

    break; // Only process the first file
  }

  return { fileBuffer, fileName, mimeType };
}

/**
 * Find the index of needle in haystack starting at offset.
 */
function indexOfBuf(haystack: Buffer, needle: Buffer, offset = 0): number {
  for (let i = offset; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}
