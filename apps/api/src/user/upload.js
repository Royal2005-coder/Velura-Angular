import { config } from "../config.js";
import { HttpError, sendJson } from "../http.js";

const STORAGE_BUCKET = "return-evidence";
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/**
 * Upload a single image file buffer to Supabase Storage.
 * Returns the public URL.
 */
export async function uploadToSupabaseStorage(buffer, filename, mimeType) {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new HttpError(503, "STORAGE_NOT_CONFIGURED", "Supabase Storage is not configured");
  }

  // Sanitize filename
  const ext = filename.split(".").pop().toLowerCase() || "jpg";
  const uniqueName = `evidence/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const uploadUrl = `${config.supabaseUrl}/storage/v1/object/${STORAGE_BUCKET}/${uniqueName}`;

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
      const errData = JSON.parse(responseText);
      errMsg = errData?.error || errData?.message || errMsg;
    } catch {}
    console.error(`[UPLOAD ERROR] Supabase Storage returned ${response.status}: ${errMsg}`);
    console.error(`[UPLOAD ERROR] Bucket '${STORAGE_BUCKET}' may not exist or missing upload policy.`);
    throw new HttpError(502, "STORAGE_UPLOAD_FAILED", `Supabase Storage: ${errMsg}`);
  }

  // Public URL format for Supabase Storage
  const publicUrl = `${config.supabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${uniqueName}`;
  return publicUrl;
}

/**
 * POST /api/user/upload/evidence
 * Accepts multipart/form-data with a single "file" field.
 * Returns { success: true, url: "https://..." }
 */
export async function handleUploadRoute(req, res, corsHeaders) {
  if (req.method !== "POST") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST is accepted");
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    throw new HttpError(400, "BAD_REQUEST", "Content-Type must be multipart/form-data");
  }

  // Extract boundary from Content-Type header
  // e.g. "multipart/form-data; boundary=----WebKitFormBoundaryXXXX"
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/i);
  if (!boundaryMatch) {
    throw new HttpError(400, "BAD_REQUEST", "Missing multipart boundary in Content-Type");
  }
  const boundary = boundaryMatch[1].replace(/^"|"$/g, ""); // strip surrounding quotes if any

  // Read entire body as a Buffer
  const chunks = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > MAX_FILE_SIZE + 8192) {
      throw new HttpError(413, "FILE_TOO_LARGE", "File exceeds 5 MB limit");
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  console.log(`[UPLOAD] Body received: ${body.length} bytes, boundary: ${boundary}`);

  // Parse multipart body
  const { fileBuffer, fileName, mimeType } = parseMultipartFile(body, boundary);

  if (!fileBuffer || fileBuffer.length === 0) {
    throw new HttpError(400, "BAD_REQUEST", "No file found in the request body");
  }

  console.log(`[UPLOAD] Parsed file: ${fileName}, type: ${mimeType}, size: ${fileBuffer.length}`);

  if (!ALLOWED_TYPES.includes(mimeType)) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE",
      `File type '${mimeType}' is not allowed. Accepted: JPG, PNG, WebP, GIF`);
  }

  const publicUrl = await uploadToSupabaseStorage(fileBuffer, fileName, mimeType);
  return sendJson(res, 200, { success: true, url: publicUrl }, corsHeaders);
}

/**
 * Parse a multipart/form-data body and return the first file part found.
 */
function parseMultipartFile(body, boundary) {
  const CRLF = Buffer.from("\r\n");
  const delimiterLine = Buffer.from(`--${boundary}`);
  const finalLine = Buffer.from(`--${boundary}--`);

  let fileBuffer = null;
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
function indexOfBuf(haystack, needle, offset = 0) {
  for (let i = offset; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}
