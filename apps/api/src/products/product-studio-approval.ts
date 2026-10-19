import { createHash, randomUUID } from "node:crypto";
import sharp, { type Metadata } from "sharp";
import { config } from "../config.js";
import { HttpError } from "../http.js";
import { requirePermission } from "../rbac.js";
import { asString, type AuthContext, type JsonObject, type RequestMeta } from "../types.js";
import { requireEnhancementQuality, type EnhancementApproval, type EnhancementApprovalRepository, type EnhancementEvidence } from "../ai/enhancement-approval-service.js";
import { measureTechnicalQuality } from "./product-ai-studio.js";

/** A Studio apply action returns a database-backed approval for exactly the bytes measured by the server. */
export interface StudioImageApproval extends EnhancementApproval { qualityScore: number; }
/** Selected public Studio bytes and their measured quality; browser-supplied scores are never evidence. */
export interface StudioImageEvidence extends EnhancementEvidence { qualityScore: number; }

/** Read only this project's uploaded/processed objects; reject redirects and arbitrary image URLs. */
export async function readStudioImageEvidence(value: string): Promise<StudioImageEvidence> {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(422, "INVALID_STUDIO_IMAGE", "Chọn ảnh đã tải lên hoặc xử lý trong Studio."); }
  if (!config.supabaseUrl || url.origin !== new URL(config.supabaseUrl).origin || url.search || url.hash ||
      !/^\/storage\/v1\/object\/public\/product-images\/(uploads|ai-studio)\/[a-f0-9-]{36}\.(png|jpg|webp)$/i.test(url.pathname)) {
    throw new HttpError(422, "INVALID_STUDIO_IMAGE", "Chỉ áp dụng ảnh từ kho Studio của sản phẩm.");
  }
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(422, "IMAGE_FETCH_FAILED", "Không đọc được ảnh Studio để phê duyệt."); }
  const max = 5 * 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(422, "INVALID_IMAGE", "Ảnh Studio trống.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > max) throw new HttpError(422, "IMAGE_TOO_LARGE", "Ảnh phê duyệt phải nhỏ hơn 5 MB.");
      chunks.push(chunk);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = Buffer.concat(chunks);
  let metadata: Metadata;
  try { metadata = await sharp(bytes).metadata(); }
  catch { throw new HttpError(422, "INVALID_IMAGE", "Không giải mã được ảnh Studio đã chọn."); }
  const mime = ({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as Record<string, string>)[metadata.format || ""];
  if (!mime) throw new HttpError(422, "INVALID_IMAGE", "Ảnh phê duyệt phải là PNG, JPG hoặc WebP.");
  const report = await measureTechnicalQuality(bytes);
  return {
    bytes, mime, qualityScore: report.overallScore,
    sourceRevision: createHash("sha256").update(bytes).digest("hex"), processingVersion: "studio-measured-v1",
    gate: { valid: report.passed, metrics: { brightness: report.metrics.brightness, sharpness: report.metrics.sharpnessScore, background_score: report.metrics.backgroundScore } },
  };
}

/** Reuse immutable approval storage and the existing transactional product-save contract for Studio selections. */
export class StudioImageApprovalService {
  constructor(private readonly repository: EnhancementApprovalRepository,
    private readonly readImage: (url: string) => Promise<StudioImageEvidence> = readStudioImageEvidence) {}

  /** Bind the explicit Apply action to reviewer, measured bytes and optimistic product version before publishing. */
  async approve(context: AuthContext | undefined, body: JsonObject, meta: RequestMeta): Promise<StudioImageApproval> {
    if (!context) throw new HttpError(401, "AUTH_REQUIRED", "Vui lòng đăng nhập.");
    requirePermission(context, "products", "update");
    if (!context.profile?.user_id || !context.profile.is_active || !["super_admin", "admin_operator_sanpham"].includes(context.roleCode))
      throw new HttpError(403, "RBAC_DENIED", "Chỉ quản lý sản phẩm được áp dụng ảnh.");
    const productId = asString(body.productId) || null;
    const expectedVersion = body.expectedVersion;
    if ((productId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(productId)) || typeof expectedVersion !== "number" ||
        !Number.isSafeInteger(expectedVersion) || (productId ? expectedVersion < 1 : expectedVersion !== 0) ||
        (body.selection !== "original" && body.selection !== "enhanced") || body.reviewConfirmed !== true)
      throw new HttpError(422, "INVALID_IMAGE_APPROVAL", "Ảnh, sản phẩm hoặc phiên bản phê duyệt không hợp lệ.");
    if (productId) {
      const current = await this.repository.productVersion(productId, context.accessToken);
      if (current !== expectedVersion) throw new HttpError(409, "VERSION_CONFLICT", "Sản phẩm đã đổi; tải lại trước khi áp dụng ảnh.");
    }
    const evidence = await this.readImage(asString(body.imageUrl));
    requireEnhancementQuality(evidence.gate);
    const approvalId = randomUUID();
    const url = await this.repository.stage(approvalId, evidence);
    const approval: StudioImageApproval = { approvalId, url, sourceRevision: evidence.sourceRevision,
      processingVersion: evidence.processingVersion, qualityScore: evidence.qualityScore, expiresAt: new Date(Date.now() + 24 * 3600000).toISOString() };
    try {
      await this.repository.record({ ...approval, productId, expectedVersion, reviewerId: context.profile.user_id,
        jobId: approvalId, selection: body.selection, imageRevision: createHash("sha256").update(evidence.bytes).digest("hex"), gate: evidence.gate, ipAddress: meta.ipAddress });
    } catch (error) {
      await this.repository.discard(approvalId, evidence.mime).catch(() => undefined);
      throw error;
    }
    return approval;
  }
}
