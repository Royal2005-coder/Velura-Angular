import { HttpError } from "../http.js";
import { insertRow, selectRows } from "../supabase.js";
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  VIDEO_MIME_TYPES,
  createSignedStorageUrl,
  readMultipartFile,
  uploadToPrivateStorage
} from "../storage.js";
import { asJsonObject, asString, type HttpRequest, type JsonObject } from "../types.js";

/** Private bucket for per-stage order evidence. */
export const ORDER_EVIDENCE_BUCKET = "order-evidence-private";

/** Stages a warehouse/CSKH operator can attach evidence to. */
export const ORDER_EVIDENCE_STAGES = [
  "pending",
  "confirmed",
  "processing",
  "shipping",
  "delivered",
  "cancelled",
  "delivery_failed"
] as const;

export type OrderEvidenceStage = (typeof ORDER_EVIDENCE_STAGES)[number];

/**
 * Reads one evidence upload and stores it under the order/stage prefix.
 * The API enforces order-operator RBAC before this runs.
 */
export async function storeOrderEvidence(input: {
  orderId: string;
  stage: string;
  note?: string;
  actorId?: string | null;
  req: HttpRequest;
}): Promise<JsonObject> {
  if (!ORDER_EVIDENCE_STAGES.includes(input.stage as OrderEvidenceStage)) {
    throw new HttpError(422, "ORDER_EVIDENCE_STAGE_INVALID", "Công đoạn nhận bằng chứng không hợp lệ.");
  }
  const file = await readMultipartFile(input.req, {
    maxBytes: MAX_VIDEO_BYTES,
    allowedTypes: [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES]
  });
  const isVideo = VIDEO_MIME_TYPES.includes(file.mimeType);
  if (!isVideo && file.fileBuffer.length > MAX_IMAGE_BYTES) {
    throw new HttpError(413, "FILE_TOO_LARGE", "Ảnh bằng chứng vượt quá 10 MB.");
  }
  const uploaded = await uploadToPrivateStorage(file.fileBuffer, file.fileName, file.mimeType, {
    bucket: ORDER_EVIDENCE_BUCKET,
    prefix: `orders/${input.orderId}/${input.stage}`
  });
  const row = await insertRow("order_evidence", {
    order_id: input.orderId,
    stage: input.stage,
    kind: isVideo ? "video" : "image",
    storage_bucket: uploaded.bucket,
    storage_path: uploaded.path,
    mime_type: file.mimeType,
    note: input.note?.trim() || null,
    uploaded_by: input.actorId || null
  });
  return evidenceView(row);
}

/**
 * Lists evidence for one order with short signed URLs. A storage hiccup must not break the
 * order drawer, so an item without a URL is still returned with its metadata.
 */
export async function listOrderEvidence(orderId: string): Promise<JsonObject[]> {
  const payload = await selectRows("order_evidence", {
    order_id: `eq.${orderId}`,
    order: "created_at.desc",
    limit: 100
  });
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  return Promise.all(rows.map((row) => evidenceView(row)));
}

async function evidenceView(value: unknown): Promise<JsonObject> {
  const row = asJsonObject(value);
  const bucket = asString(row.storage_bucket);
  const path = asString(row.storage_path);
  let url = "";
  if (bucket && path) {
    try {
      url = await createSignedStorageUrl(bucket, path, 900);
    } catch {
      url = "";
    }
  }
  return {
    evidence_id: asString(row.evidence_id),
    stage: asString(row.stage),
    kind: asString(row.kind),
    mime_type: asString(row.mime_type),
    note: asString(row.note),
    uploaded_by: asString(row.uploaded_by),
    created_at: asString(row.created_at),
    url,
    ...(url ? {} : { unavailable: true })
  };
}
