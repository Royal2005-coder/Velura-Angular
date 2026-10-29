import { HttpError, sendJson } from "../http.js";
import { guestSessionPhone } from "./order-access.js";
import { hasGuestOrderAccess } from "./order-access.js";
import { insertRow, selectOne } from "../supabase.js";
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  VIDEO_MIME_TYPES,
  MAX_VIDEO_BYTES,
  PRIVATE_EVIDENCE_BUCKET,
  uploadToPrivateStorage,
  createSignedStorageUrl,
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

  const url = new URL(req.url || "/", "http://localhost");
  if (url.searchParams.get("purpose") === "return") {
    const orderId = url.searchParams.get("order_id") || "";
    const order = await selectOne("orders", { order_id: `eq.${orderId}` });
    const token = url.searchParams.get("guest_access_token") || asString(req.headers["x-guest-access-token"]);
    if (!order || (context.profile
      ? order.user_id !== context.profile.user_id
      : !hasGuestOrderAccess(order, { guest_access_token: token }))) {
      throw new HttpError(404, "NOT_FOUND", "Order not found");
    }
    const kind = url.searchParams.get("kind");
    if (kind !== "request_photo" && kind !== "request_video") throw new HttpError(422, "INVALID_EVIDENCE_KIND", "Choose request_photo or request_video");
    const video = kind === "request_video";
    const file = await readMultipartFile(req, { maxBytes: video ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES, allowedTypes: video ? VIDEO_MIME_TYPES : IMAGE_MIME_TYPES });
    const bytes = file.fileBuffer;
    const matches = file.mimeType === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : file.mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : file.mimeType === "image/webp" ? bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
      : file.mimeType === "image/gif" ? ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))
      : file.mimeType === "video/mp4" ? bytes.toString("ascii", 4, 8) === "ftyp"
      : bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!matches) throw new HttpError(415, "EVIDENCE_CONTENT_MISMATCH", "Nội dung tệp không khớp loại ảnh/video.");
    const uploaded = await uploadToPrivateStorage(bytes, file.fileName, file.mimeType, { bucket: PRIVATE_EVIDENCE_BUCKET, prefix: `return-intake/${orderId}/${kind}` });
    const ref = `storage://${uploaded.bucket}/${uploaded.path}`;
    await insertRow("return_intake_upload", { storage_ref: ref, order_id: orderId, storage_bucket: uploaded.bucket, storage_path: uploaded.path, mime_type: file.mimeType, kind, uploaded_by: context.profile?.user_id || null });
    return sendJson(res, 200, { success: true, storage_ref: ref, url: await createSignedStorageUrl(uploaded.bucket, uploaded.path) }, corsHeaders);
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
