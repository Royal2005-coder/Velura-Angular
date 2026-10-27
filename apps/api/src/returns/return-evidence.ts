import { HttpError } from "../http.js";
import { insertRow, selectRows } from "../supabase.js";
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  PRIVATE_EVIDENCE_BUCKET,
  VIDEO_MIME_TYPES,
  createSignedStorageUrl,
  readMultipartFile,
  uploadToPrivateStorage
} from "../storage.js";
import { asJsonObject, asString, type HttpRequest, type JsonObject } from "../types.js";

export type ReturnEvidenceKind =
  | "request_photo"
  | "packing_photo"
  | "packing_video"
  | "pickup_photo"
  | "pickup_video"
  | "qa_photo"
  | "qa_video"
  | "refund_proof"
  | "other";

export type ReturnEvidenceRole = "customer" | "carrier" | "admin" | "system";

const CUSTOMER_KINDS: readonly ReturnEvidenceKind[] = ["packing_photo", "packing_video"];
const ADMIN_KINDS: readonly ReturnEvidenceKind[] = [
  "request_photo",
  "packing_photo",
  "packing_video",
  "pickup_photo",
  "pickup_video",
  "qa_photo",
  "qa_video",
  "refund_proof",
  "other"
];

/**
 * Reads, stores and signs one return evidence file.
 *
 * The file never becomes a public URL: it is written to the private bucket and the row keeps
 * only storage coordinates. Readers receive a 15-minute signed URL, so a leaked page cache
 * cannot expose packing/pickup videos forever.
 */
export async function storeReturnEvidence(input: {
  returnId: string;
  kind: ReturnEvidenceKind;
  role: ReturnEvidenceRole;
  actorId?: string | null;
  shipmentId?: string | null;
  note?: string | null;
  req: HttpRequest;
}): Promise<JsonObject> {
  const kind = input.kind;
  const allowed = input.role === "customer" ? CUSTOMER_KINDS : ADMIN_KINDS;
  if (!allowed.includes(kind)) {
    throw new HttpError(422, "EVIDENCE_KIND_NOT_ALLOWED", "Loại bằng chứng không được phép cho vai trò này.");
  }
  const isVideo = kind.endsWith("_video");
  const file = await readMultipartFile(input.req, {
    maxBytes: isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES,
    allowedTypes: isVideo ? VIDEO_MIME_TYPES : IMAGE_MIME_TYPES
  });
  const uploaded = await uploadToPrivateStorage(file.fileBuffer, file.fileName, file.mimeType, {
    bucket: PRIVATE_EVIDENCE_BUCKET,
    prefix: `returns/${input.returnId}/${kind}`
  });
  const row = await insertRow("return_evidence", {
    return_id: input.returnId,
    shipment_id: input.shipmentId || null,
    kind,
    storage_bucket: uploaded.bucket,
    storage_path: uploaded.path,
    mime_type: file.mimeType,
    uploaded_by_role: input.role,
    uploaded_by: input.actorId || null,
    note: input.note || null
  });
  return {
    ...(await evidenceView(asJsonObject(row))),
    storage_ref: storageRef(uploaded.bucket, uploaded.path)
  };
}

/** Stable, non-expiring reference stored in shipment rows instead of a signed URL. */
export function storageRef(bucket: string, path: string): string {
  return `storage://${bucket}/${path}`;
}

/**
 * Reads the evidence ledger for one return, newest last, and signs private objects.
 */
export async function listReturnEvidence(returnId: string): Promise<JsonObject[]> {
  const { rows } = await selectRows("return_evidence", {
    return_id: `eq.${returnId}`,
    order: "created_at.asc",
    limit: 200
  });
  return Promise.all(rows.map((row) => evidenceView(asJsonObject(row))));
}

/** Resolves a stored `storage://bucket/path` reference into a short-lived signed URL. */
export async function resolveEvidenceRef(ref: unknown): Promise<string> {
  const value = asString(ref).trim();
  if (!value.startsWith("storage://")) return value;
  const rest = value.slice("storage://".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return "";
  try {
    return await createSignedStorageUrl(rest.slice(0, slash), rest.slice(slash + 1));
  } catch {
    return "";
  }
}

/**
 * Adds a signed URL to a stored evidence row without changing the stored coordinates.
 */
export async function evidenceView(row: JsonObject): Promise<JsonObject> {
  const bucket = asString(row.storage_bucket);
  const path = asString(row.storage_path);
  if (!bucket || !path) return row;
  try {
    const signed = await createSignedStorageUrl(bucket, path);
    return { ...row, url: signed || null };
  } catch {
    // A storage outage must not hide the rest of the return; the row still carries its metadata.
    return { ...row, url: null };
  }
}
