import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { HttpError } from "../http.js";
import { asJsonObject } from "../types.js";
import { validateColorResult } from "./personal-color-policy.js";
import type { ColorAnalysis, ColorAssets, ColorPrincipal, ColorRepository, ColorVision, PersonalColorPolicy } from "./personal-color-types.js";

/** Consent-bound two-stage vision analysis; only repository.confirm can change the effective Style Profile. */
export class PersonalColorService {
  private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly repo: ColorRepository, private readonly assets: ColorAssets, private readonly vision: ColorVision, private readonly policy: PersonalColorPolicy | null) {}

  /** Report disabled production capability until policy and a real gateway are configured. */
  capabilities() {
    const enabled = !!this.policy?.approved && this.vision.ready();
    return { enabled, reason: enabled ? undefined : this.policy ? "COLOR_VISION_UNAVAILABLE" : "COLOR_POLICY_APPROVAL_REQUIRED", policy_version: this.policy?.version, max_upload_bytes: this.policy?.maxBytes, retention_seconds: this.policy?.retentionSeconds, palette: this.policy?.palette, taxonomy: this.policy?.taxonomy };
  }

  /** Return confirmed profile data and current optimistic-lock version, not previews. */
  async profile(principal: ColorPrincipal) { return this.repo.profile(principal); }

  /** Begin an owner-bound preview; client-supplied versions cannot overwrite a newer Style Profile. */
  async analyze(principal: ColorPrincipal, body: Record<string, unknown>): Promise<ColorAnalysis> {
    const policy = this.policy;
    if (!policy?.approved || !this.vision.ready()) throw new HttpError(503, "COLOR_UNAVAILABLE", "Phân tích màu chưa được bật. Bạn vẫn có thể dùng Style Quiz.");
    if (body.consent !== true || body.policy_version !== policy.version) throw new HttpError(400, "COLOR_CONSENT_REQUIRED", "Xác nhận đồng ý xử lý ảnh theo chính sách hiện hành.");
    if (typeof body.asset_id !== "string" || !/^[a-f0-9-]{36}$/i.test(body.asset_id) || !Number.isSafeInteger(body.expected_version) || Number(body.expected_version) < 0) throw new HttpError(400, "COLOR_INPUT_INVALID", "Ảnh hoặc phiên bản hồ sơ không hợp lệ.");
    const image = await this.assets.readOwnedAsset(principal.owner, body.asset_id);
    if (image.bytes.length > policy.maxBytes || !["image/jpeg", "image/png"].includes(image.mime) || Date.parse(image.expires_at) <= Date.now()) throw new HttpError(400, "COLOR_IMAGE_INVALID", "Ảnh phải là JPEG/PNG hợp lệ trong giới hạn đã công bố.");
    const analysis = await this.repo.begin(principal, { id: randomUUID(), status: "RUNNING", profile_version: Number(body.expected_version), policy_version: policy.version, expires_at: new Date(Math.min(Date.now() + policy.retentionSeconds * 1000, Date.parse(image.expires_at))).toISOString() });
    const controller = new AbortController();
    this.controllers.set(analysis.id, controller);
    void this.run(principal, analysis, image, body.asset_id, controller, policy);
    return analysis;
  }

  /** Owner-authorized polling projects finite timeout state even after process restart. */
  async get(principal: ColorPrincipal, id: string): Promise<ColorAnalysis> { return this.repo.get(principal, id); }

  /** Cancel before or after inference; late model success cannot replace cancelled state. */
  async cancel(principal: ColorPrincipal, id: string): Promise<ColorAnalysis> {
    await this.repo.get(principal, id);
    const value = await this.repo.finish(principal, id, { status: "CANCELLED" });
    this.controllers.get(id)?.abort();
    return value;
  }

  /** Explicit confirmation rejects low confidence, stale profile/policy, expired analysis and concurrent confirmations. */
  async confirm(principal: ColorPrincipal, id: string, version: unknown) {
    if (!Number.isSafeInteger(version) || Number(version) < 0) throw new HttpError(400, "COLOR_VERSION_INVALID", "Phiên bản hồ sơ không hợp lệ.");
    const analysis = await this.repo.get(principal, id);
    if (!this.policy || analysis.policy_version !== this.policy.version || analysis.status !== "SUCCESS" || !analysis.result || analysis.result.confidence < this.policy.minConfidence) throw new HttpError(409, "COLOR_NOT_CONFIRMABLE", "Kết quả chưa đủ điều kiện xác nhận. Hãy chụp ảnh khác.");
    validateColorResult({ season: analysis.result.season, subtype: analysis.result.subtype, palette: analysis.result.palette, avoided: analysis.result.avoided, confidence: analysis.result.confidence }, this.policy);
    return this.repo.confirm(principal, id, Number(version));
  }
  /** Stop active analyses during API shutdown; persistent polling still reports their bounded expiry. */
  close(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  private async run(principal: ColorPrincipal, analysis: ColorAnalysis, image: { bytes: Buffer; mime: string }, assetId: string, controller: AbortController, policy: PersonalColorPolicy): Promise<void> {
    let timedOut = false;
    let rejectTimeout: (reason: Error) => void = () => undefined;
    const deadline = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); rejectTimeout(new Error("COLOR_TIMEOUT")); }, Math.min(policy.timeoutMs, Math.max(1, Date.parse(analysis.expires_at) - Date.now())));
    try {
      const inference = async () => {
        try {
          const decoder = sharp(image.bytes, { failOn: "warning", limitInputPixels: policy.maxPixels });
          const metadata = await decoder.metadata();
          if (!metadata.width || !metadata.height || metadata.width < policy.minWidth || metadata.height < policy.minHeight || metadata.width * metadata.height > policy.maxPixels || metadata.pages && metadata.pages > 1 || metadata.format !== (image.mime === "image/png" ? "png" : "jpeg")) throw new Error("COLOR_IMAGE_INVALID");
          await decoder.stats();
        } catch {
          return { status: "VALIDATION_FAILED" as const, error: "COLOR_IMAGE_INVALID" };
        }
        if (controller.signal.aborted) throw new Error("COLOR_CANCELLED");
        const raw = await this.vision.generate("Validate this portrait BEFORE personal-color inference. Return booleans lighting_valid (neutral daylight, no colored lighting/overexposure), skin_visible (unobstructed face with natural skin), blur_free, filter_free (no beauty filter or color grading). Do not infer season. Reject uncertain image suitability.", image,
          { type: "object", additionalProperties: false, required: ["lighting_valid", "skin_visible", "blur_free", "filter_free"], properties: { lighting_valid: { type: "boolean" }, skin_visible: { type: "boolean" }, blur_free: { type: "boolean" }, filter_free: { type: "boolean" } } }, { model: policy.model, signal: controller.signal });
        const quality = asJsonObject(raw);
        if (Object.keys(quality).length !== 4 || ["lighting_valid", "skin_visible", "blur_free", "filter_free"].some((key) => quality[key] !== true)) {
          return { status: "VALIDATION_FAILED" as const, error: "COLOR_PICTURE_GUIDANCE" };
        }
        if (controller.signal.aborted) throw new Error("COLOR_CANCELLED");
        const output = await this.vision.generate(`Analyze personal color only from this validated portrait. Use exactly the approved taxonomy ${JSON.stringify(policy.taxonomy)} and palette IDs ${JSON.stringify(policy.palette)}. Return season, subtype, palette, avoided and confidence (0..1). Palette and avoided must be distinct nonempty lists. Do not force high confidence when evidence is uncertain. Do not infer ethnicity, health or identity.`, image,
          { type: "object", additionalProperties: false, required: ["season", "subtype", "palette", "avoided", "confidence"], properties: { season: { type: "string", enum: Object.keys(policy.taxonomy) }, subtype: { type: "string", enum: Object.values(policy.taxonomy).flat() }, palette: { type: "array", items: { type: "string", enum: Object.keys(policy.palette) } }, avoided: { type: "array", items: { type: "string", enum: Object.keys(policy.palette) } }, confidence: { type: "number", minimum: 0, maximum: 1 } } }, { model: policy.model, signal: controller.signal });
        const result = validateColorResult(output, policy);
        return { status: result.confidence < policy.minConfidence ? "LOW_CONFIDENCE" as const : "SUCCESS" as const, result };
      };
      const patch = await Promise.race([inference(), deadline]);
      if (!controller.signal.aborted) await this.repo.finish(principal, analysis.id, patch);
    } catch {
      await this.repo.finish(principal, analysis.id, { status: timedOut ? "TIMEOUT" : controller.signal.aborted ? "CANCELLED" : "FAILED", error: timedOut ? "COLOR_TIMEOUT" : "COLOR_ANALYSIS_FAILED" }).catch(() => undefined);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(analysis.id);
      await this.assets.deleteOwnedAsset(principal.owner, assetId).catch(() => undefined);
    }
  }
}
