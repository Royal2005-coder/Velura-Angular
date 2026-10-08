import { config, getSupabaseServiceKey } from "../config.js";
import { HttpError } from "../http.js";
import { callRpc, selectOne } from "../supabase.js";
import type { EnhancementApprovalRecord, EnhancementApprovalRepository, EnhancementEvidence } from "./enhancement-approval-service.js";

function objectPath(id: string, mime: string): string {
  const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return `ai-reviewed/${id}.${extension}`;
}

/** Persist immutable selected assets and approval evidence without mutating the published product. */
export class SupabaseEnhancementApprovalRepository implements EnhancementApprovalRepository {
  /** Read the current product lock with the caller's authenticated permission. */
  async productVersion(productId: string, accessToken: string): Promise<number | null> {
    const product = await selectOne("product", { select: "version", product_id: `eq.${productId}` }, { accessToken });
    return product && typeof product.version === "number" ? product.version : null;
  }

  private async storage(path: string, method: "POST" | "DELETE", evidence?: EnhancementEvidence): Promise<void> {
    const key = getSupabaseServiceKey();
    if (!key || !config.supabaseUrl)
      throw new HttpError(503, "SERVICE_ROLE_REQUIRED", "Kho ảnh phê duyệt chưa được cấu hình.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetch(`${config.supabaseUrl}/storage/v1/object/product-images/${path}`, {
        method, signal: controller.signal,
        headers: {
          apikey: key, authorization: `Bearer ${key}`,
          ...(evidence ? { "content-type": evidence.mime, "x-upsert": "false" } : {}),
        },
        ...(evidence ? { body: evidence.bytes } : {}),
      });
      if (!response.ok)
        throw new HttpError(502, "IMAGE_STAGING_FAILED", "Chưa lưu được ảnh phê duyệt. Ảnh đã công bố được giữ nguyên.");
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "IMAGE_STORAGE_UNAVAILABLE", "Kho ảnh chưa truy cập được. Ảnh đã công bố được giữ nguyên.");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Upload once under an opaque approval ID; overwriting previously approved bytes is forbidden. */
  async stage(id: string, evidence: EnhancementEvidence): Promise<string> {
    const path = objectPath(id, evidence.mime);
    await this.storage(path, "POST", evidence);
    return `${config.supabaseUrl}/storage/v1/object/public/product-images/${path}`;
  }

  /** Remove only this failed approval's unused immutable object. */
  async discard(id: string, mime: string): Promise<void> {
    await this.storage(objectPath(id, mime), "DELETE");
  }

  /** Trusted server-only RPC rechecks actual database role, product version and structured evidence. */
  async record(input: EnhancementApprovalRecord): Promise<void> {
    await callRpc("velura_stage_image_approval", {
      p_approval_id: input.approvalId,
      p_actor_id: input.reviewerId,
      p_product_id: input.productId,
      p_expected_version: input.expectedVersion,
      p_job_id: input.jobId,
      p_selection: input.selection,
      p_asset_url: input.url,
      p_source_revision: input.sourceRevision,
      p_image_revision: input.imageRevision,
      p_processing_version: input.processingVersion,
      p_quality_gate: input.gate,
      p_expires_at: input.expiresAt,
      p_ip_address: input.ipAddress,
    }, { useAnonKey: false });
  }
}
