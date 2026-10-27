import { config, getSupabaseServiceKey } from "./config.js";
import { HttpError } from "./http.js";
import type { HttpRequest } from "./types.js";

/** Bucket công khai cũ cho ảnh bằng chứng khách gửi (giữ tương thích dữ liệu cũ). */
export const PUBLIC_EVIDENCE_BUCKET = "return-evidence";
/** Bucket riêng cho bằng chứng returns: ảnh + video đóng gói/pickup/QA. */
export const PRIVATE_EVIDENCE_BUCKET = "return-evidence-private";

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
export const VIDEO_MIME_TYPES = ["video/mp4", "video/webm"];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/** Kho chứa và thư mục con bên trong kho. */
export interface StorageTarget {
  bucket: string;
  prefix: string;
}

/** Tệp đã đọc xong từ thân yêu cầu multipart. */
export interface UploadedFile {
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
}

/**
 * Đọc một tệp từ multipart/form-data và kiểm tra kích thước/kiểu tệp theo tuyến gọi.
 * Ảnh và video dùng chung bộ đọc này; giới hạn được truyền vào để tuyến video không
 * vô tình mở rộng giới hạn của tuyến ảnh.
 */
export async function readMultipartFile(
  req: HttpRequest,
  options: { maxBytes: number; allowedTypes: readonly string[] } = {
    maxBytes: MAX_IMAGE_BYTES,
    allowedTypes: IMAGE_MIME_TYPES
  }
): Promise<UploadedFile> {
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
    if (totalSize > options.maxBytes + 8192) {
      throw new HttpError(413, "FILE_TOO_LARGE", `File exceeds ${Math.round(options.maxBytes / 1024 / 1024)} MB limit`);
    }
    chunks.push(buffer);
  }

  const { fileBuffer, fileName, mimeType } = parseMultipartFile(Buffer.concat(chunks), boundary);
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new HttpError(400, "BAD_REQUEST", "No file found in the request body");
  }
  if (!options.allowedTypes.includes(mimeType)) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", `File type '${mimeType}' is not allowed`);
  }
  return { fileBuffer, fileName, mimeType };
}

/**
 * Upload a single file buffer to Supabase Storage and return the public URL.
 * Kept for the legacy customer evidence endpoint.
 */
export async function uploadToSupabaseStorage(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  target: StorageTarget = { bucket: PUBLIC_EVIDENCE_BUCKET, prefix: "evidence" }
): Promise<string> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new HttpError(503, "STORAGE_NOT_CONFIGURED", "Supabase Storage is not configured");
  }
  const uniqueName = storageName(target.prefix, filename);
  const uploadUrl = `${config.supabaseUrl}/storage/v1/object/${target.bucket}/${uniqueName}`;
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: config.supabaseAnonKey,
      authorization: `Bearer ${config.supabaseAnonKey}`,
      "content-type": mimeType,
      "x-upsert": "true"
    },
    body: buffer
  });
  if (!response.ok) {
    throw new HttpError(502, "STORAGE_UPLOAD_FAILED", `Supabase Storage: ${await storageError(response)}`);
  }
  return `${config.supabaseUrl}/storage/v1/object/public/${target.bucket}/${uniqueName}`;
}

/**
 * Upload to the private evidence bucket and return the storage coordinates. Callers store
 * the path in `return_evidence`, never a public URL; readers receive a short-lived signed URL.
 */
export async function uploadToPrivateStorage(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  target: StorageTarget
): Promise<{ bucket: string; path: string }> {
  const key = getSupabaseServiceKey();
  if (!config.supabaseUrl || !key) {
    throw new HttpError(503, "STORAGE_NOT_CONFIGURED", "Supabase Storage is not configured");
  }
  const path = storageName(target.prefix, filename);
  const uploadUrl = `${config.supabaseUrl}/storage/v1/object/${target.bucket}/${path}`;
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": mimeType,
      "x-upsert": "false"
    },
    body: buffer
  });
  if (!response.ok) {
    throw new HttpError(502, "STORAGE_UPLOAD_FAILED", `Supabase Storage: ${await storageError(response)}`);
  }
  return { bucket: target.bucket, path };
}

/**
 * Create a short-lived signed URL for one private evidence object.
 */
export async function createSignedStorageUrl(
  bucket: string,
  path: string,
  expiresInSeconds = 900
): Promise<string> {
  const key = getSupabaseServiceKey();
  if (!config.supabaseUrl || !key) {
    throw new HttpError(503, "STORAGE_NOT_CONFIGURED", "Supabase Storage is not configured");
  }
  if (!bucket || !path) return "";
  const response = await fetch(`${config.supabaseUrl}/storage/v1/object/sign/${bucket}/${path}`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ expiresIn: expiresInSeconds })
  });
  if (!response.ok) {
    throw new HttpError(502, "STORAGE_SIGN_FAILED", `Supabase Storage: ${await storageError(response)}`);
  }
  const payload = await response.json() as { signedURL?: string };
  const signed = String(payload.signedURL || "");
  if (!signed) return "";
  return signed.startsWith("http") ? signed : `${config.supabaseUrl}/storage/v1${signed}`;
}

function storageName(prefix: string, filename: string): string {
  const ext = sanitizeExtension(filename);
  return `${prefix.replace(/^\/+|\/+$/g, "")}/${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`;
}

function sanitizeExtension(filename: string): string {
  const raw = String(filename || "").split(".").pop()?.toLowerCase() || "bin";
  return /^[a-z0-9]{2,5}$/.test(raw) ? raw : "bin";
}

async function storageError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const payload = JSON.parse(text) as { error?: string; message?: string };
    return String(payload.error || payload.message || `HTTP ${response.status}`);
  } catch {
    return `HTTP ${response.status}`;
  }
}

function parseMultipartFile(
  body: Buffer,
  boundary: string
): { fileBuffer: Buffer | null; fileName: string; mimeType: string } {
  const delimiterLine = Buffer.from(`--${boundary}`);
  let fileBuffer: Buffer | null = null;
  let fileName = "upload.bin";
  let mimeType = "application/octet-stream";
  let pos = 0;

  while (pos < body.length) {
    const boundaryPos = indexOfBuf(body, delimiterLine, pos);
    if (boundaryPos === -1) break;
    pos = boundaryPos + delimiterLine.length;
    if (body[pos] === 45 && body[pos + 1] === 45) break;
    if (body[pos] === 13 && body[pos + 1] === 10) pos += 2;
    const headersEnd = indexOfBuf(body, Buffer.from("\r\n\r\n"), pos);
    if (headersEnd === -1) break;
    const headerBlock = body.slice(pos, headersEnd).toString("utf8");
    pos = headersEnd + 4;
    if (!headerBlock.includes("filename=")) continue;
    const fnMatch = headerBlock.match(/filename="([^"]+)"/i);
    if (fnMatch) fileName = fnMatch[1];
    const ctMatch = headerBlock.match(/Content-Type:\s*([^\r\n]+)/i);
    if (ctMatch) mimeType = ctMatch[1].trim();
    const nextBoundary = indexOfBuf(body, Buffer.from(`\r\n--${boundary}`), pos);
    fileBuffer = nextBoundary === -1 ? body.slice(pos) : body.slice(pos, nextBoundary);
    break;
  }
  return { fileBuffer, fileName, mimeType };
}

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
