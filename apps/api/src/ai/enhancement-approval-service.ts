import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "../http.js";
import { requirePermission } from "../rbac.js";
import { asString, type AuthContext, type JsonObject, type RequestMeta } from "../types.js";

/** A deliberate administrator selection; neither inference nor approval publishes the catalog. */
export type EnhancementSelection = "original" | "enhanced";
/** Evidence read from an owner-checked, successful, unexpired engine job, never supplied by the browser. */
export interface EnhancementEvidence {
  bytes: Buffer;
  mime: string;
  sourceRevision: string;
  processingVersion: string;
  gate: Record<string, unknown>;
}
/** Engine boundary must enforce private asset/job ownership and return measured quality of selected bytes. */
export interface EnhancementApprovalEngine {
  approvalEvidence(owner: string, jobId: string, selection: EnhancementSelection): Promise<EnhancementEvidence>;
}
/** Saved selection is only consumed by a later, successful product mutation. */
export interface EnhancementApproval {
  approvalId: string;
  url: string;
  sourceRevision: string;
  processingVersion: string;
  expiresAt: string;
}
/** Immutable staging data; database validates the actual reviewer role and expected product version again. */
export interface EnhancementApprovalRecord extends EnhancementApproval {
  productId: string | null;
  expectedVersion: number;
  reviewerId: string;
  jobId: string;
  selection: EnhancementSelection;
  imageRevision: string;
  gate: Record<string, unknown>;
  ipAddress: string;
}
/** Database and immutable storage operations; publishing product.images is intentionally absent. */
export interface EnhancementApprovalRepository {
  productVersion(productId: string, accessToken: string): Promise<number | null>;
  stage(id: string, evidence: EnhancementEvidence): Promise<string>;
  discard(id: string, mime: string): Promise<void>;
  record(input: EnhancementApprovalRecord): Promise<void>;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Validate measured quality, not generative fashion fidelity; human visual approval remains mandatory. */
export function requireEnhancementQuality(gate: Record<string, unknown>): void {
  const metrics = gate.metrics;
  if (gate.valid !== true || !metrics || typeof metrics !== "object" || Array.isArray(metrics))
    throw new HttpError(422, "IMAGE_QUALITY_FAILED", "Ảnh được chọn chưa đạt ngưỡng kiểm tra chất lượng.");
  const values = metrics as Record<string, unknown>;
  if (!["brightness", "sharpness", "background_score"].every((key) =>
    typeof values[key] === "number" && Number.isFinite(values[key])))
    throw new HttpError(422, "IMAGE_QUALITY_INCOMPLETE", "Thiếu số đo ánh sáng, độ nét hoặc nền ảnh.");
}

/** Approval records validated selected bytes; only an atomic catalog save can publish them. */
export class EnhancementApprovalService {
  constructor(private readonly engine: EnhancementApprovalEngine, private readonly repository: EnhancementApprovalRepository) {}

  /** Bind explicit visual approval to reviewer, source revision, processing version and optimistic product lock. */
  async approve(context: AuthContext | undefined, body: JsonObject, meta: RequestMeta): Promise<EnhancementApproval> {
    if (!context) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
    requirePermission(context, "products", "update");
    if (!["super_admin", "admin_operator_sanpham"].includes(context.roleCode) || !context.profile?.user_id)
      throw new HttpError(403, "RBAC_DENIED", "Chỉ quản lý sản phẩm được phê duyệt ảnh.");
    const jobId = asString(body.jobId);
    const productId = asString(body.productId) || null;
    const selection = body.selection;
    const expectedVersion = body.expectedVersion;
    if (!UUID.test(jobId) || (productId && !UUID.test(productId)) ||
      (selection !== "original" && selection !== "enhanced") ||
      typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
      (productId ? expectedVersion < 1 : expectedVersion !== 0))
      throw new HttpError(422, "INVALID_IMAGE_APPROVAL", "Ảnh, sản phẩm hoặc phiên bản không hợp lệ.");
    if (body.reviewConfirmed !== true)
      throw new HttpError(422, "VISUAL_REVIEW_REQUIRED", "Hãy so sánh màu, hình dáng, logo và họa tiết trước khi phê duyệt.");
    if (productId) {
      const version = await this.repository.productVersion(productId, context.accessToken);
      if (version === null) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product was not found");
      if (version !== expectedVersion) throw new HttpError(409, "VERSION_CONFLICT", "Sản phẩm đã thay đổi. Tải lại trước khi phê duyệt.");
    }
    const evidence = await this.engine.approvalEvidence(`member:${context.authUser!.id}`, jobId, selection);
    requireEnhancementQuality(evidence.gate);
    if (!/^[a-f0-9]{64}$/i.test(evidence.sourceRevision) || !evidence.processingVersion.trim() ||
      evidence.processingVersion.length > 200 || !["image/jpeg", "image/png", "image/webp"].includes(evidence.mime) ||
      evidence.bytes.length < 12 || evidence.bytes.length > 5 * 1024 * 1024)
      throw new HttpError(422, "INVALID_IMAGE_EVIDENCE", "Kết quả xử lý ảnh chưa đủ thông tin để phê duyệt.");
    const approvalId = randomUUID();
    const url = await this.repository.stage(approvalId, evidence);
    const approval: EnhancementApproval = {
      approvalId, url, sourceRevision: evidence.sourceRevision,
      processingVersion: evidence.processingVersion,
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    };
    try {
      await this.repository.record({
        ...approval, productId, expectedVersion, jobId, selection,
        reviewerId: context.profile.user_id,
        imageRevision: createHash("sha256").update(evidence.bytes).digest("hex"),
        gate: evidence.gate, ipAddress: meta.ipAddress,
      });
    } catch (error) {
      // The published image is never touched; cleanup failure must not disguise the failed approval.
      await this.repository.discard(approvalId, evidence.mime).catch(() => undefined);
      throw error;
    }
    return approval;
  }
}
