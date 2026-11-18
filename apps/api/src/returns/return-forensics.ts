/**
 * Return Parcel Visual Forensics & Carrier Dispute Helper.
 *
 * Resolves private evidence images (`pickup_photo` / `packing_photo` vs `qa_photo`) or operator-supplied
 * base64 inspection frames, invokes `UnifiedDecisionService.decideReturnBoxForensics`, and persists
 * immutable forensics audit rows in `public.return_box_forensics`.
 */

import { config } from "../config.js";
import { HttpError } from "../http.js";
import { insertRow, selectRows } from "../supabase.js";
import { asJsonObject, asString, type JsonObject } from "../types.js";
import { unifiedDecisionService } from "../decision/decision-service.js";
import type { ReturnBoxForensicsDecision } from "../decision/decision-types.js";
import { listReturnEvidence, resolveEvidenceRef } from "./return-evidence.js";

/**
 * Evaluates a return parcel's structural integrity and pickup-vs-warehouse identity verification.
 */
export async function executeReturnBoxForensics(input: {
  returnRow: JsonObject;
  shipments: JsonObject[];
  body: JsonObject;
  actorId: string | null;
}): Promise<ReturnBoxForensicsDecision & { forensics_id?: string }> {
  const returnId = asString(input.returnRow.return_id);
  const returnCode = asString(input.returnRow.return_code) || null;
  const inbound = input.shipments.find((s) => asString(s.direction) === "inbound") || input.shipments[0] || {};
  const trackingCode = asString(input.body.trackingCode || inbound.tracking_code) || null;
  const carrierName = asString(input.body.carrier || inbound.carrier) || null;
  const returnItemId = asString(input.body.returnItemId).trim() || null;

  const evidenceRows = await listReturnEvidence(returnId).catch(() => [] as JsonObject[]);

  // 1. Resolve Warehouse QA Photo (operator upload base64, explicit URL/ref, or latest stored qa_photo)
  const warehouseB64 = asString(input.body.warehouseImageBase64).trim();
  const warehouseRef = asString(input.body.warehouseEvidenceRef).trim();
  let warehouseImage: { bytes: Buffer; mime: "image/jpeg" | "image/png" | "image/webp" } | null = null;
  let storedWarehouseRef: string | null = warehouseRef || null;

  if (warehouseB64) {
    warehouseImage = decodeImageBase64(warehouseB64);
  } else if (warehouseRef) {
    const signed = await resolveEvidenceRef(warehouseRef);
    warehouseImage = await fetchSignedEvidenceBytes(signed || warehouseRef);
  } else {
    const latestQa = [...evidenceRows].reverse().find((r) => asString(r.kind) === "qa_photo" && asString(r.url));
    if (latestQa) {
      storedWarehouseRef = `storage://${asString(latestQa.storage_bucket)}/${asString(latestQa.storage_path)}`;
      warehouseImage = await fetchSignedEvidenceBytes(asString(latestQa.url));
    }
  }

  if (!warehouseImage) {
    throw new HttpError(
      422,
      "WAREHOUSE_QA_IMAGE_REQUIRED",
      "Vui lòng chọn hoặc tải lên ảnh chụp thực tế kiện hàng tại kho (Ảnh B) để AI giám định ngoại quan.",
    );
  }

  // 2. Resolve Shipper Pickup / Customer Handover Photo (optional Image A for anti-swap verification)
  const pickupB64 = asString(input.body.pickupImageBase64).trim();
  const pickupRef = asString(input.body.pickupEvidenceRef).trim();
  let pickupImage: { bytes: Buffer; mime: "image/jpeg" | "image/png" | "image/webp" } | null = null;
  let storedPickupRef: string | null = pickupRef || null;

  if (pickupB64) {
    pickupImage = decodeImageBase64(pickupB64);
  } else if (pickupRef) {
    const signed = await resolveEvidenceRef(pickupRef);
    pickupImage = await fetchSignedEvidenceBytes(signed || pickupRef).catch(() => null);
  } else {
    const pickupEvidence =
      [...evidenceRows].reverse().find((r) => asString(r.kind) === "pickup_photo" && asString(r.url)) ||
      [...evidenceRows].reverse().find((r) => asString(r.kind) === "packing_photo" && asString(r.url));
    if (pickupEvidence) {
      storedPickupRef = `storage://${asString(pickupEvidence.storage_bucket)}/${asString(pickupEvidence.storage_path)}`;
      pickupImage = await fetchSignedEvidenceBytes(asString(pickupEvidence.url)).catch(() => null);
    } else if (Array.isArray(inbound.pickup_photo_urls) && inbound.pickup_photo_urls.length) {
      const firstRef = asString(inbound.pickup_photo_urls[0]);
      storedPickupRef = firstRef;
      const signed = await resolveEvidenceRef(firstRef);
      if (signed) {
        pickupImage = await fetchSignedEvidenceBytes(signed).catch(() => null);
      }
    }
  }

  const decision = await unifiedDecisionService.decideReturnBoxForensics({
    returnId,
    returnCode,
    trackingCode,
    carrierName,
    pickupImage,
    warehouseImage,
    actorId: input.actorId,
  });

  let forensicsId: string | undefined;
  if (config.supabaseUrl && config.supabaseServiceRoleKey && /^[0-9a-f-]{36}$/i.test(returnId)) {
    try {
      const inserted = asJsonObject(
        await insertRow("return_box_forensics", {
          return_id: returnId,
          return_item_id: returnItemId && /^[0-9a-f-]{36}$/i.test(returnItemId) ? returnItemId : null,
          pickup_evidence_ref: storedPickupRef,
          warehouse_evidence_ref: storedWarehouseRef,
          box_condition: decision.box_condition,
          carrier_claim_recommended: decision.carrier_claim_recommended,
          match_verdict: decision.match_verdict,
          tampering_risk_score: decision.tampering_risk_score,
          confidence_score: decision.confidence_score,
          requires_human_review: decision.requires_human_review,
          freeze_auto_refund: decision.freeze_auto_refund,
          diff_factors: [...decision.diff_factors],
          factor_probabilities: decision.factor_probabilities,
          carrier_claim_report: decision.carrier_claim_report as unknown as JsonObject,
        }),
      );
      forensicsId = asString(inserted.forensics_id) || undefined;
    } catch {
      // Non-blocking if migration 133 has not yet been applied
    }
  }

  return {
    ...decision,
    ...(forensicsId ? { forensics_id: forensicsId } : {}),
  };
}

/** Lists stored parcel forensics QA history for a return request. */
export async function listStoredReturnBoxForensics(returnId: string): Promise<JsonObject[]> {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) return [];
  try {
    const res = await selectRows("return_box_forensics", {
      return_id: `eq.${returnId}`,
      order: "created_at.desc",
      limit: "20",
    });
    return (res.rows || []).map(asJsonObject);
  } catch {
    return [];
  }
}

function decodeImageBase64(raw: string): { bytes: Buffer; mime: "image/jpeg" | "image/png" | "image/webp" } {
  const cleaned = raw.replace(/^data:[^;]+;base64,/, "").trim();
  const bytes = Buffer.from(cleaned, "base64");
  if (bytes.length < 16 || bytes.length > 10 * 1024 * 1024) {
    throw new HttpError(422, "INVALID_IMAGE", "Ảnh giám định không hợp lệ hoặc vượt quá 10 MB.");
  }
  return { bytes, mime: sniffMime(bytes) };
}

async function fetchSignedEvidenceBytes(url: string): Promise<{ bytes: Buffer; mime: "image/jpeg" | "image/png" | "image/webp" }> {
  if (!/^https?:\/\//i.test(url)) {
    throw new HttpError(422, "INVALID_EVIDENCE_URL", "Không đọc được đường dẫn bằng chứng riêng tư.");
  }
  const resp = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new HttpError(422, "EVIDENCE_FETCH_FAILED", "Không tải được ảnh bằng chứng từ kho lưu trữ.");
  }
  const bytes = Buffer.from(await resp.arrayBuffer());
  if (bytes.length < 16 || bytes.length > 10 * 1024 * 1024) {
    throw new HttpError(422, "INVALID_IMAGE", "Ảnh bằng chứng trống hoặc vượt giới hạn.");
  }
  return { bytes, mime: sniffMime(bytes) };
}

function sniffMime(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return "image/jpeg";
}
