import { HttpError, sendJson } from "../http.js";
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  PUBLIC_EVIDENCE_BUCKET,
  readMultipartFile,
  uploadToSupabaseStorage,
  VIDEO_MIME_TYPES,
} from "../storage.js";
import type { AuthContext, HeaderMap, HttpRequest, HttpResponse } from "../types.js";

const ALLOWED_MEDIA_TYPES = [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES];
const MAX_MEDIA_BYTES = MAX_VIDEO_BYTES; // Up to 50MB for video, validated per type

export async function handleAdminMediaUpload(args: {
  req: HttpRequest;
  res: HttpResponse;
  url: URL;
  parts: string[];
  context: AuthContext;
  headers: HeaderMap;
}): Promise<boolean> {
  const { req, res, url, parts, headers } = args;

  const isMediaUploadRoute =
    (parts[1] === "v1" && parts[2] === "admin" && parts[3] === "content" && parts[4] === "upload-media") ||
    (parts[1] === "v1" && parts[2] === "admin" && parts[3] === "upload" && parts[4] === "media");

  if (!isMediaUploadRoute) return false;

  if (req.method !== "POST") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Chỉ chấp nhận phương thức POST");
  }

  const category = url.searchParams.get("category") || "media";
  const prefix = category === "banner" ? "banners" : category === "collection" ? "collections" : "cms-media";

  const file = await readMultipartFile(req, {
    maxBytes: MAX_MEDIA_BYTES,
    allowedTypes: ALLOWED_MEDIA_TYPES,
  });

  const isVideo = VIDEO_MIME_TYPES.includes(file.mimeType);
  if (!isVideo && file.fileBuffer.length > MAX_IMAGE_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Ảnh tải lên vượt quá dung lượng tối đa 10MB");
  }

  const publicUrl = await uploadToSupabaseStorage(
    file.fileBuffer,
    file.fileName,
    file.mimeType,
    { bucket: PUBLIC_EVIDENCE_BUCKET, prefix }
  );

  sendJson(
    res,
    200,
    {
      success: true,
      url: publicUrl,
      fileName: file.fileName,
      mimeType: file.mimeType,
      mediaType: isVideo ? "video" : "image",
    },
    headers
  );
  return true;
}
