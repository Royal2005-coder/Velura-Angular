import { HttpError, sendJson } from "../http.js";
import { guestSessionPhone } from "./order-access.js";
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  PUBLIC_EVIDENCE_BUCKET,
  readMultipartFile,
  uploadToSupabaseStorage,
  type StorageTarget,
  type UploadedFile
} from "../storage.js";
import { asString, type AuthContext, type HeaderMap, type HttpRequest, type HttpResponse } from "../types.js";

export type { StorageTarget };
export type UploadedImage = UploadedFile;
export { uploadToSupabaseStorage };

/**
 * Reads one image for the legacy evidence/banner routes. New return evidence uses
 * `readMultipartFile` directly so it can accept packing/pickup videos as well.
 */
export async function readMultipartImage(req: HttpRequest): Promise<UploadedFile> {
  return readMultipartFile(req, { maxBytes: MAX_IMAGE_BYTES, allowedTypes: IMAGE_MIME_TYPES });
}

/**
 * POST /api/user/upload/evidence
 * Legacy public-bucket image upload for customer return photos and reviews.
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

  let folderId = context.profile?.user_id;
  if (!folderId) {
    const url = new URL(req.url || "/", "http://localhost");
    const guestHeader = asString(req.headers["x-guest-access-token"] || "");
    const token = (url.searchParams.get("guest_access_token") || guestHeader).trim();
    const phone = guestSessionPhone(token);
    if (!phone) {
      throw new HttpError(401, "UNAUTHORIZED", "Vui lòng đăng nhập hoặc xác thực số điện thoại để tải ảnh lên");
    }
    folderId = `guest_${phone}`;
  }

  const { fileBuffer, fileName, mimeType } = await readMultipartImage(req);
  const publicUrl = await uploadToSupabaseStorage(fileBuffer, fileName, mimeType, {
    bucket: PUBLIC_EVIDENCE_BUCKET,
    prefix: `evidence/${folderId}`
  });
  return sendJson(res, 200, { success: true, url: publicUrl }, corsHeaders);
}
