import { randomUUID, createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { copyFile, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { HttpError } from "../http.js";
import { asString, asJsonObject, type JsonObject } from "../types.js";
import { LocalAiRepository } from "./ai-repository.js";
import { loadStudioAssets } from "./studio-assets.js";
import sharp from "sharp";
import type { EnhancementEvidence, EnhancementSelection } from "./enhancement-approval-service.js";
import {
  LocalImageVectorRepository,
  normalizedImageVector,
  type VisualSearchFilters,
  type CatalogImageVector,
} from "./image-vector-repository.js";
import type {
  AiAsset,
  AiJob,
  AiJobView,
  AiTask,
  AiWorker,
  AiWorkerResult,
  AiPoseRef,
} from "./ai-types.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASKS: AiTask[] = [
  "image_quality",
  "image_embedding",
  "virtual_try_on",
  "product_image_enhance",
];
/** Job errors caused by the platform (restart/deploy, engine down, storage); they never consume a VTO-10 retry. */
const NOT_AN_ATTEMPT: Record<string, true> = { AI_JOB_INTERRUPTED: true, AI_ENGINE_UNAVAILABLE: true, AI_QUEUE_STORAGE_FAILED: true };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
/** Catalog adapter chooses shop garments server-side, never a caller-controlled remote URL. */
export interface AiCatalog {
  garment(
    productId: string,
    variantId: string,
  ): Promise<{ bytes: Buffer; category: string }>;
  studio(id: string): Promise<Buffer>;
  searchable(productId: string, imageRevision?: string): Promise<boolean>;
  image(productId: string): Promise<{
    bytes: Buffer;
    metadata: Omit<CatalogImageVector, "embedding">;
  }>;
  support?(
    productId: string,
    variantId?: string,
  ): Promise<{
    product_supported: boolean;
    variant_supported: boolean;
    garment_category?: string;
  }>;
}
/** Local serialized inference queue binds consent, assets, TTL and retries to the same principal. */
export class AiService {
  private pumping = false;
  private storageBlocked = false;
  private closed = false;
  private work?: Promise<void>;
  private maintenance?: ReturnType<typeof setInterval>;
  private readonly controllers = new Map<string, AbortController>();
  /** Last time each VTO job's product/variant was confirmed still tryable; a viewer fetches 24 frames at once. */
  private readonly supportCheckedAt = new Map<string, number>();
  private creating: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly repo: LocalAiRepository,
    private readonly worker: AiWorker,
    private readonly catalog: AiCatalog,
    private readonly vectors = new LocalImageVectorRepository(repo.root),
  ) {}
  private retentionSeconds(): number {
    const seconds = Number(process.env.AI_PRIVATE_TTL_SECONDS || 3600);
    if (!Number.isSafeInteger(seconds) || seconds < 1)
      throw new HttpError(503, "AI_RETENTION_NOT_CONFIGURED", "Chính sách lưu ảnh chưa hợp lệ.");
    return seconds;
  }
  private maxVtoAttempts(): number {
    const attempts = Number(process.env.AI_VTO_MAX_ATTEMPTS || 3);
    if (!Number.isSafeInteger(attempts) || attempts < 1)
      throw new HttpError(503, "AI_RETRY_NOT_CONFIGURED", "Chính sách thử lại chưa hợp lệ.");
    return attempts;
  }
  /** Licensed female studio models in registry order; the first is the standing model. */
  private studioAssets(): Array<{ id: string; label: string; gender: string; season?: string; occasion?: string; badge?: string }> {
    const { root, registry } = loadStudioAssets();
    return Object.entries(registry).flatMap(([id, raw]) => {
      const asset = asJsonObject(raw),
        file = asString(asset.file),
        path = resolve(root, file);
      if (asString(asset.gender) === "male") return [];
      return /^[a-zA-Z0-9_-]{1,64}$/.test(id) &&
        asset.licensed === true &&
        !!file &&
        path.startsWith(root + sep) &&
        existsSync(path)
        ? [
            {
              id,
              label: asString(asset.label) || id,
              gender: asString(asset.gender) || "unspecified",
              season: asString(asset.season) || undefined,
              occasion: asString(asset.occasion) || undefined,
              badge: asString(asset.badge) || undefined,
            },
          ]
        : [];
    });
  }
  /** Report actual operator-enabled runtime state; no fabricated readiness. */
  capabilities() {
    const verified = (process.env.AI_VERIFIED_TASKS || "").split(",");
    const allowed = !this.storageBlocked && process.env.AI_DISABLE !== "true" && process.env.AI_ENABLE !== "false" &&
      (process.env.AI_ENABLE === "true" || process.env.NODE_ENV !== "production");
    const enabled = allowed && TASKS.some(task => verified.includes(task) && this.worker.ready(task));
    const studio_assets = this.studioAssets();
    return {
      enabled,
      local_only: true,
      max_upload_bytes: 8 * 1024 * 1024,
      private_ttl_seconds: this.retentionSeconds(),
      max_vto_attempts: this.maxVtoAttempts(),
      studio_assets,
      tasks: TASKS.map((task) => ({
        task,
        enabled: allowed && this.worker.ready(task) && verified.includes(task),
        ...(allowed && this.worker.ready(task) && verified.includes(task)
          ? {}
          : { reason: "AI_ENGINE_UNAVAILABLE" }),
      })),
    };
  }
  /** Product capability validates shop configuration before asking customers to upload a personal photo. */
  async productCapabilities(
    productId: string,
    variantId?: string,
  ): Promise<{
    product_supported: boolean;
    variant_supported: boolean;
    garment_category?: string;
  }> {
    if (
      !UUID.test(productId) ||
      (variantId && !UUID.test(variantId)) ||
      !this.catalog.support
    )
      return { product_supported: false, variant_supported: false };
    return this.catalog.support(productId, variantId);
  }
  /** Refresh authenticated task readiness before accepting work; a stale observation cannot enable inference. */
  async refreshReadiness(): Promise<void> {
    await this.worker.refreshReadiness?.();
  }
  /** Preview only a registered licensed studio image before the customer consents to VTO. */
  async studioPreview(id: string): Promise<{ bytes: Buffer; mime: string }> {
    const bytes = await this.catalog.studio(id);
    if (bytes.length > 8 * 1024 * 1024)
      throw new HttpError(413, "IMAGE_TOO_LARGE", "Ảnh studio quá lớn.");
    const mime = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? "image/jpeg"
        : undefined;
    if (!mime)
      throw new HttpError(
        415,
        "INVALID_STUDIO_IMAGE",
        "Ảnh studio phải là PNG hoặc JPEG hợp lệ.",
      );
    return { bytes, mime };
  }
  private enabled(task?: AiTask): void {
    const capabilities = this.capabilities();
    if (
      !capabilities.enabled ||
      (task &&
        !capabilities.tasks.some((row) => row.task === task && row.enabled))
    )
      throw new HttpError(
        503,
        "AI_ENGINE_UNAVAILABLE",
        "Bộ xử lý AI chưa sẵn sàng.",
      );
  }
  /** Upload a bounded sniffed raster to a private one-hour asset, never public evidence storage. */
  async upload(
    owner: string,
    bytes: Buffer,
    mime: string,
  ): Promise<{ asset_id: string; expires_at: string }> {
    if (this.storageBlocked || process.env.AI_DISABLE === "true" || process.env.AI_ENABLE === "false" ||
        (process.env.NODE_ENV === "production" && process.env.AI_ENABLE !== "true")) {
      throw new HttpError(503, "AI_ENGINE_UNAVAILABLE", "Kho ảnh riêng chưa được bật.");
    }
    if (bytes.length < 12 || bytes.length > 8 * 1024 * 1024)
      throw new HttpError(413, "INVALID_IMAGE", "Ảnh phải dưới 8 MB.");
    const valid =
      (mime === "image/png" &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (mime === "image/jpeg" &&
        bytes[0] === 255 &&
        bytes[1] === 216 &&
        bytes[2] === 255) ||
      (mime === "image/webp" &&
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP");
    if (!valid)
      throw new HttpError(
        415,
        "INVALID_IMAGE",
        "Chỉ nhận ảnh JPEG, PNG hoặc WebP hợp lệ.",
      );
    try {
      const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: 20_000_000, animated: false });
      const metadata = await decoder.metadata();
      const expected = mime === "image/jpeg" ? "jpeg" : mime === "image/png" ? "png" : "webp";
      if (metadata.format !== expected || !metadata.width || !metadata.height || (metadata.pages || 1) !== 1) throw new Error("IMAGE_FORMAT");
      const raster = decoder.rotate();
      bytes = await (expected === "jpeg" ? raster.jpeg({ quality: 95 }) : expected === "png" ? raster.png() : raster.webp({ quality: 95 })).toBuffer();
      if (bytes.length > 8 * 1024 * 1024) throw new Error("IMAGE_SIZE");
    } catch { throw new HttpError(422, "INVALID_IMAGE", "Ảnh không đọc được hoặc vượt giới hạn điểm ảnh."); }
    await this.purgeExpired();
    const id = randomUUID();
    const asset: AiAsset = {
      id,
      owner,
      path: join(this.repo.root, "assets", `${id}.image`),
      mime,
      expires_at: new Date(Date.now() + this.retentionSeconds() * 1000).toISOString(),
    };
    await this.repo.saveAsset(asset, bytes);
    return { asset_id: id, expires_at: asset.expires_at };
  }
  private async asset(owner: string, value: unknown): Promise<AiAsset> {
    const id = asString(value);
    if (!UUID.test(id))
      throw new HttpError(400, "INVALID_ASSET", "Chọn ảnh trước khi xử lý.");
    const asset = await this.repo.asset(id);
    if (
      !asset ||
      asset.owner !== owner ||
      Date.parse(asset.expires_at) <= Date.now()
    )
      throw new HttpError(404, "ASSET_NOT_FOUND", "Ảnh không còn khả dụng.");
    return asset;
  }
  /** Read a current private asset for the same verified principal; no path or URL comes from the caller. */
  async readOwnedAsset(owner: string, id: string): Promise<{ bytes: Buffer; mime: string; expires_at: string }> {
    const asset = await this.asset(owner, id);
    return { bytes: await readFile(asset.path), mime: asset.mime, expires_at: asset.expires_at };
  }
  /** Erase an owner's source image at completion, including expired assets; foreign IDs are not exposed. */
  async deleteOwnedAsset(owner: string, id: string): Promise<void> {
    if (!UUID.test(id)) throw new HttpError(404, "ASSET_NOT_FOUND", "Ảnh không còn khả dụng.");
    const asset = await this.repo.asset(id);
    if (!asset || asset.owner !== owner) throw new HttpError(404, "ASSET_NOT_FOUND", "Ảnh không còn khả dụng.");
    await this.repo.deleteAsset(id);
  }
  /** Attest selected bytes from a successful owner-bound quality/enhancement job, never client measurements. */
  async approvalEvidence(owner: string, id: string, selection: EnhancementSelection): Promise<EnhancementEvidence> {
    const job = await this.owned(owner, id);
    if (job.status !== "success" || job.task !== (selection === "original" ? "image_quality" : "product_image_enhance") ||
        job.gate?.valid !== true || !job.processing_version) {
      throw new HttpError(422, "IMAGE_NOT_APPROVABLE", "Ảnh chưa có kết quả kiểm tra hợp lệ.");
    }
    const source = await readFile(join(job.directory, "input.image"));
    const bytes = selection === "original" ? source : await this.repo.result(job);
    const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: 20_000_000, animated: false });
    const metadata = await decoder.metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format || "") || (metadata.pages || 1) !== 1) throw new HttpError(422, "INVALID_IMAGE_EVIDENCE", "Không đọc được ảnh đã chọn.");
    await decoder.stats();
    return {
      bytes, mime: metadata.format === "jpeg" ? "image/jpeg" : metadata.format === "png" ? "image/png" : "image/webp",
      sourceRevision: createHash("sha256").update(source).digest("hex"), processingVersion: job.processing_version, gate: job.gate,
    };
  }
  /** Serialize enqueue to make duplicate submissions idempotent even while inputs are copied. */
  async create(
    owner: string,
    body: JsonObject,
    admin = false,
  ): Promise<AiJobView> {
    const pending = this.creating.then(() =>
      this.createOnce(owner, body, admin),
    );
    this.creating = pending.catch(() => undefined);
    return pending;
  }
  private async createOnce(
    owner: string,
    body: JsonObject,
    admin: boolean,
  ): Promise<AiJobView> {
    if (this.closed) throw new HttpError(503, "AI_ENGINE_UNAVAILABLE", "Bộ xử lý AI đang dừng.");
    await this.refreshReadiness();
    this.enabled();
    await this.purgeExpired();
    const task = asString(body.task) as AiTask;
    if (!TASKS.includes(task))
      throw new HttpError(400, "INVALID_TASK", "Tác vụ AI không được hỗ trợ.");
    this.enabled(task);
    if (task === "product_image_enhance" && !admin)
      throw new HttpError(
        403,
        "RBAC_DENIED",
        "Chỉ quản lý sản phẩm được chỉnh ảnh.",
      );
    if (body.consent !== true || body.confirmed !== true)
      throw new HttpError(
        400,
        "CONSENT_REQUIRED",
        "Cần đồng ý xử lý ảnh và xác nhận ảnh xem trước.",
      );
    const key = asString(body.idempotency_key);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key))
      throw new HttpError(
        400,
        "IDEMPOTENCY_REQUIRED",
        "Thiếu mã yêu cầu hợp lệ.",
      );
    const { idempotency_key: ignored, ...payload } = body;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(canonical(payload)))
      .digest("hex");
    const jobs = await this.repo.jobs();
    const duplicate = jobs.find(
      (job) => job.owner === owner && job.idempotency_key === key,
    );
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint)
        throw new HttpError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Yêu cầu đã thay đổi. Vui lòng tạo yêu cầu mới.",
        );
      return this.view(duplicate);
    }
    const active = jobs.find(
      (job) =>
        job.owner === owner &&
        job.fingerprint === fingerprint &&
        ["queued", "running"].includes(job.status),
    );
    if (active) return this.view(active);
    // VTO-10: infrastructure faults (restart, engine down, storage) are the shop's failure, not a user attempt.
    const attempts = task === "virtual_try_on"
      ? jobs.filter(job => job.owner === owner && job.fingerprint === fingerprint && !NOT_AN_ATTEMPT[job.error ?? ""])
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
      : [];
    if (task === "virtual_try_on" && attempts.length >= this.maxVtoAttempts())
      throw new HttpError(429, "AI_RETRY_LIMIT", "Đã đạt giới hạn thử lại cho ảnh và sản phẩm này.");
    if (
      jobs.filter((job) => ["queued", "running"].includes(job.status)).length >= 12 ||
      jobs.filter(
        (job) =>
          job.owner === owner && ["queued", "running"].includes(job.status),
      ).length >= 2
    )
      throw new HttpError(
        429,
        "AI_QUEUE_FULL",
        "Hãy đợi tác vụ hiện tại hoàn tất.",
      );
    const id = randomUUID(),
      directory = join(this.repo.root, "jobs", id);
    const worker: Record<string, unknown> = {
      task,
      request_id: id,
      product_id: "",
      variant_id: "",
      consent: true,
      confirmed: true,
      // Poses are fixed here so a later asset change cannot alter a running job.
    };
    let catalog_metadata: Omit<CatalogImageVector, "embedding"> | undefined;
    let catalog_batch_metadata: AiJob["catalog_batch_metadata"];
    const inputErrors: Array<{ product_id: string; error: string }> = [];
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      if (task === "virtual_try_on") {
        const productId = asString(body.product_id),
          variantId = asString(body.variant_id);
        if (
          !UUID.test(productId) ||
          !UUID.test(variantId) ||
          !["personal", "studio"].includes(asString(body.mode))
        )
          throw new HttpError(
            400,
            "INVALID_PRODUCT",
            "Chọn sản phẩm, biến thể và chế độ thử đồ hợp lệ.",
          );
        const support = await this.productCapabilities(productId, variantId);
        if (!support.product_supported || !support.variant_supported) throw new HttpError(422, "VTO_PRODUCT_UNAVAILABLE", "Sản phẩm hoặc biến thể chưa hỗ trợ thử đồ.");
        const garment = await this.catalog.garment(productId, variantId);
        await writeFile(join(directory, "garment.image"), garment.bytes, {
          mode: 0o600,
        });
        if (body.mode === "studio") {
          const poseIds = this.studioAssets().map((asset) => asset.id);
          if (!poseIds.length)
            throw new HttpError(503, "AI_STUDIO_UNAVAILABLE", "Người mẫu studio chưa sẵn sàng.");
          // The first licensed asset is the standing model; it decides the job's own result.
          worker.pose_ids = poseIds;
          await writeFile(join(directory, "person.image"), await this.catalog.studio(poseIds[0]), { mode: 0o600 });
        } else
          await copyFile(
            (await this.asset(owner, body.person_asset_id)).path,
            join(directory, "person.image"),
          );
        Object.assign(worker, {
          mode: body.mode,
          garment_category: garment.category,
          product_id: productId,
          variant_id: variantId,
          garment_photo_type: "flat-lay",
          garment: "garment.image",
          person: "person.image",
        });
      } else {
        if (body.catalog_index === true) {
          if (!admin || task !== "image_embedding")
            throw new HttpError(
              403,
              "RBAC_DENIED",
              "Chỉ quản lý được lập chỉ mục ảnh shop.",
            );
          if (Array.isArray(body.catalog_product_ids)) {
            const ids = body.catalog_product_ids;
            if (
              ids.length < 1 ||
              ids.length > 16 ||
              new Set(ids).size !== ids.length ||
              ids.some((id) => typeof id !== "string" || !UUID.test(id))
            )
              throw new HttpError(
                400,
                "INVALID_CATALOG_BATCH",
                "Chọn tối đa 16 sản phẩm hợp lệ.",
              );
            catalog_batch_metadata = [];
            let size = 0;
            for (let i = 0; i < ids.length; i++) {
              const productId = String(ids[i]);
              try {
                const catalogImage = await this.catalog.image(productId);
                size += catalogImage.bytes.length;
                if (size > 32 * 1024 * 1024)
                  throw new HttpError(
                    413,
                    "BATCH_TOO_LARGE",
                    "Nhóm ảnh quá lớn.",
                  );
                const image = `catalog-${i}.image`;
                await writeFile(join(directory, image), catalogImage.bytes, {
                  mode: 0o600,
                });
                catalog_batch_metadata.push({
                  image,
                  metadata: catalogImage.metadata,
                });
              } catch (error) {
                if (
                  error instanceof HttpError &&
                  error.code === "BATCH_TOO_LARGE"
                )
                  throw error;
                inputErrors.push({
                  product_id: productId,
                  error:
                    error instanceof HttpError
                      ? error.code
                      : "CATALOG_IMAGE_UNAVAILABLE",
                });
              }
            }
            if (!catalog_batch_metadata.length)
              throw new HttpError(
                422,
                "CATALOG_BATCH_EMPTY",
                "Không có ảnh shop khả dụng trong nhóm.",
              );
            worker.images = catalog_batch_metadata.map((row) => row.image);
          } else {
            if (!UUID.test(asString(body.product_id)))
              throw new HttpError(
                400,
                "INVALID_PRODUCT",
                "Chọn sản phẩm hợp lệ.",
              );
            const catalogImage = await this.catalog.image(
              asString(body.product_id),
            );
            await writeFile(
              join(directory, "input.image"),
              catalogImage.bytes,
              { mode: 0o600 },
            );
            catalog_metadata = catalogImage.metadata;
          }
        } else
          await copyFile(
            (await this.asset(owner, body.image_asset_id)).path,
            join(directory, "input.image"),
          );
        if (!worker.images) worker.image = "input.image";
        worker.person_check = body.person_check === true;
        if (task === "product_image_enhance") {
          if (
            body.background !== undefined &&
            !["white", "transparent"].includes(asString(body.background))
          )
            throw new HttpError(
              400,
              "INVALID_BACKGROUND",
              "Nền ảnh không hợp lệ.",
            );
          worker.options = {
            background: body.background,
            brightness: body.brightness === true,
            sharpness: body.sharpness === true,
          };
        }
      }
      const now = new Date().toISOString();
      const job: AiJob = {
        id,
        task,
        status: "queued",
        owner,
        idempotency_key: key,
        fingerprint,
        directory,
        worker,
        ...(task === "virtual_try_on" ? { product_id: asString(body.product_id), variant_id: asString(body.variant_id) } : {}),
        ...(task === "virtual_try_on" ? {
          attempt: attempts.length + 1,
          retry_of: attempts.at(-1)?.id,
        } : {}),
        catalog_metadata,
        catalog_batch_metadata,
        ...(inputErrors.length
          ? {
              index_summary: {
                indexed: 0,
                failed: inputErrors.length,
                errors: inputErrors,
              },
            }
          : {}),
        created_at: now,
        expires_at: new Date(Date.now() + this.retentionSeconds() * 1000).toISOString(),
      };
      // Query filters are private worker metadata and never customer image embeddings persisted in the catalog.
      const filters = asJsonObject(body.filters);
      for (const [key, value] of Object.entries(filters)) {
        if (
          ![
            "category_id",
            "style_tags",
            "color_tone",
            "occasions",
            "suitable_body_shapes",
            "product_ids",
          ].includes(key) ||
          (["category_id", "color_tone"].includes(key)
            ? typeof value !== "string" || value.length > 100
            : !Array.isArray(value) ||
              value.length > (key === "product_ids" ? 500 : 12) ||
              value.some((v) => typeof v !== "string" || v.length > 100)) ||
          (key === "product_ids" &&
            Array.isArray(value) &&
            value.some(
              (v) =>
                typeof v !== "string" ||
                !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
                  v,
                ),
            ))
        ) {
          throw new HttpError(
            400,
            "INVALID_FILTERS",
            "Bộ lọc tìm kiếm không hợp lệ.",
          );
        }
      }
      worker.filters = filters;
      await writeFile(join(directory, "job.json"), JSON.stringify(worker), {
        mode: 0o600,
      });
      if (this.closed) throw new HttpError(503, "AI_ENGINE_UNAVAILABLE", "Bộ xử lý AI đang dừng.");
      await this.repo.saveJob(job);
      this.startPump();
      return this.view(job);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  private view(job: AiJob): AiJobView {
    return {
      id: job.id,
      task: job.task,
      status: job.status,
      created_at: job.created_at,
      expires_at: job.expires_at,
      ...(job.task === "virtual_try_on" ? { product_id: job.product_id, variant_id: job.variant_id } : {}),
      ...(job.attempt ? { attempt: job.attempt, retry_of: job.retry_of } : {}),
      ...(job.result_url ? { result_url: job.result_url } : {}),
      ...(["running", "success"].includes(job.status) && job.poses?.length ? { poses: job.poses } : {}),
      ...(job.gate ? { gate: job.gate } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.matches ? { matches: job.matches } : {}),
      ...(job.index_summary ? { index_summary: job.index_summary } : {}),
    };
  }
  private async owned(owner: string, id: string): Promise<AiJob> {
    if (!UUID.test(id))
      throw new HttpError(404, "JOB_NOT_FOUND", "Không tìm thấy tác vụ.");
    const job = await this.repo.job(id);
    if (!job || job.owner !== owner || Date.parse(job.expires_at) <= Date.now())
      throw new HttpError(404, "JOB_NOT_FOUND", "Không tìm thấy tác vụ.");
    return job;
  }
  /** Return only owner-authorized state; polling also resumes a stopped local queue. */
  async get(owner: string, id: string): Promise<AiJobView> {
    if (this.storageBlocked) throw new HttpError(503, "AI_QUEUE_STORAGE_FAILED", "Kho tác vụ tạm thời không khả dụng.");
    const job = await this.owned(owner, id);
    this.startPump();
    return this.view(job);
  }
  /** Recover a lost create response using the same owner-scoped idempotency key; no global job listing. */
  async getByKey(owner: string, key: string): Promise<AiJobView> {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key))
      throw new HttpError(400, "INVALID_KEY", "Mã yêu cầu không hợp lệ.");
    const job = (await this.repo.jobs()).find(
      (row) =>
        row.owner === owner &&
        row.idempotency_key === key &&
        Date.parse(row.expires_at) > Date.now(),
    );
    if (!job)
      throw new HttpError(404, "JOB_NOT_FOUND", "Không tìm thấy tác vụ.");
    return this.view(job);
  }
  /** Cancellation never publishes a late image after a worker returns. */
  async cancel(owner: string, id: string): Promise<AiJobView> {
    const job = await this.owned(owner, id);
    const updated = await this.repo.transition(id, ["queued", "running"], {
      status: "cancelled",
    });
    if (updated) this.controllers.get(id)?.abort();
    return this.view(updated || job);
  }
  /** Serve private bounded output bytes only for a successfully completed owned job. */
  async result(owner: string, id: string): Promise<Buffer> {
    const job = await this.owned(owner, id);
    if (this.storageBlocked) throw new HttpError(503, "AI_QUEUE_STORAGE_FAILED", "Kho tác vụ tạm thời không khả dụng.");
    if (job.task === "virtual_try_on") await this.requireVtoSelectionSupported(job);
    if (job.status !== "success" || !job.result_url)
      throw new HttpError(
        409,
        "RESULT_UNAVAILABLE",
        "Ảnh kết quả chưa sẵn sàng.",
      );
    return this.repo.result(job);
  }
  /** Serve one studio pose the job has already published; the record, not a path pattern, decides. */
  async resultFile(owner: string, id: string, name: string): Promise<Buffer> {
    const job = await this.owned(owner, id);
    if (this.storageBlocked) throw new HttpError(503, "AI_QUEUE_STORAGE_FAILED", "Kho tác vụ tạm thời không khả dụng.");
    // Poses depict the same product as the 2D result, so they follow the same withdrawal rule (VTO-03/11).
    if (job.task === "virtual_try_on") await this.requireVtoSelectionSupported(job, 30_000);
    if (!["running", "success"].includes(job.status) || !(job.poses || []).some((pose) => pose.id === name))
      throw new HttpError(409, "RESULT_UNAVAILABLE", "Ảnh dáng này chưa sẵn sàng.");
    return this.repo.resultFile(job, name);
  }
  /**
   * A VTO output is served only while its exact product/variant is still offered for try-on. `reuseMs` lets the
   * frame burst of one viewer share a single catalog check instead of 2 reads per frame.
   */
  private async requireVtoSelectionSupported(job: AiJob, reuseMs = 0): Promise<void> {
    const checkedAt = this.supportCheckedAt.get(job.id);
    if (reuseMs && checkedAt && Date.now() - checkedAt < reuseMs) return;
    const support = await this.productCapabilities(job.product_id!, job.variant_id);
    if (!support.product_supported || !support.variant_supported) {
      this.supportCheckedAt.delete(job.id);
      throw new HttpError(409, "VTO_PRODUCT_UNAVAILABLE", "Sản phẩm hoặc biến thể không còn hỗ trợ thử đồ.");
    }
    for (const [id, at] of this.supportCheckedAt) if (Date.now() - at >= 30_000) this.supportCheckedAt.delete(id);
    this.supportCheckedAt.set(job.id, Date.now());
  }
  /** Remove expired jobs/assets, never the directory of a job a worker is still writing into. */
  private purgeExpired(): Promise<void> {
    return this.repo.purge(Date.now(), new Set(this.controllers.keys()));
  }
  /** After a restart: interrupted running work fails (not a user attempt); queued work and pending 360° stages resume. */
  async recover(): Promise<void> {
    await this.purgeExpired();
    for (const job of await this.repo.jobs()) {
      if (job.status === "running")
        await this.repo.transition(job.id, ["running"], {
          status: "failed",
          error: "AI_JOB_INTERRUPTED",
        });
      // A pending 360° stage is left pending: nothing runs in a fresh process, and the pump picks it up once the
      // 2D queue is empty (or marks it failed when the worker cannot render it).
    }
    this.startPump();
    if (!this.maintenance) {
      this.maintenance = setInterval(
        () => void this.purgeExpired().catch(() => undefined),
        60_000,
      );
      this.maintenance.unref();
    }
  }
  /** Stop maintenance when a local test/server closes; does not claim remote inference stopped. */
  async close(): Promise<void> {
    clearInterval(this.maintenance);
    this.closed = true;
    await this.creating;
    for (const controller of this.controllers.values()) controller.abort("shutdown");
    await this.work;
  }
  private startPump(): void {
    if (this.closed || this.pumping) return;
    this.work = this.pump().catch(() => {
      this.storageBlocked = true;
      console.error("AI_QUEUE_STORAGE_FAILED");
    });
  }
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      await this.refreshReadiness();
      while (!this.closed) {
        await this.refreshReadiness();
        const live = (await this.repo.jobs()).filter((row) => Date.parse(row.expires_at) > Date.now());
        const job = live
          .filter((row) => row.status === "queued")
          .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
        if (!job) break;
        if (!this.worker.ready(job.task)) {
          await this.repo.transition(job.id, ["queued"], { status: "failed", error: "AI_ENGINE_UNAVAILABLE" });
          continue;
        }
        if (
          !(await this.repo.transition(job.id, ["queued"], {
            status: "running",
          }))
        )
          continue;
        job.status = "running";
        const controller = new AbortController();
        this.controllers.set(job.id, controller);
        // VTO-09: the try-on gets 120 s from the moment it starts running. A studio job arms that bound per pose
        // inside runStudio and keeps one overall cap of the same length for every pose.
        const studio = job.task === "virtual_try_on" && job.worker.mode === "studio";
        const poseCount = studio && Array.isArray(job.worker.pose_ids) ? job.worker.pose_ids.length : 1;
        const timeout = setTimeout(
          () => controller.abort("deadline"),
          job.task === "virtual_try_on" ? 120_000 * poseCount : 60_000,
        );
        timeout.unref();
        try {
          const result = studio
            ? await this.runStudio(job, controller)
            : await this.worker.run(job.directory, controller.signal);
          if (controller.signal.aborted) throw new Error("AI_JOB_TIMEOUT");
          const current = await this.repo.job(job.id);
          if (current?.status === "cancelled") continue;
          if (job.task === "virtual_try_on") {
            if (!result.binding || result.binding.request_id !== job.id ||
                result.binding.product_id !== job.product_id || result.binding.variant_id !== job.variant_id) throw new Error("AI_WORKER_BINDING_MISMATCH");
            const support = await this.productCapabilities(job.product_id!, job.variant_id);
            if (!support.product_supported || !support.variant_supported) throw new Error("VTO_PRODUCT_UNAVAILABLE");
          }
          job.status = result.status;
          job.gate = result.gate;
          job.processing_version = result.processing_version;
          if (result.status === "success" &&
              ["virtual_try_on", "product_image_enhance"].includes(job.task) &&
              (result.result_file !== "result.png" || result.gate?.valid !== true))
            throw new Error("INVALID_IMAGE_RESULT");
          if (
            result.result_file === "result.png" &&
            result.status === "success"
          ) {
            const output = sharp(await this.repo.result(job), { failOn: "warning", limitInputPixels: 20_000_000 });
            const metadata = await output.metadata();
            if (metadata.format !== "png" || (metadata.pages || 1) !== 1) throw new Error("INVALID_IMAGE_RESULT");
            await output.stats();
            job.result_url = `jobs/${job.id}/result`;
          }
          if (job.task === "image_embedding" && result.status === "success") {
            if (job.catalog_batch_metadata) {
              if (
                result.model !== "openclip-vit-b32-laion2b" ||
                result.dimensions !== 512 ||
                !Array.isArray(result.batch_embeddings) ||
                result.batch_embeddings.length !==
                  job.catalog_batch_metadata.length ||
                new Set(result.batch_embeddings.map((row) => row.image))
                  .size !== result.batch_embeddings.length
              )
                throw new Error("INVALID_IMAGE_BATCH");
              const rows: CatalogImageVector[] = [];
              const errors = job.index_summary?.errors || [];
              for (const expected of job.catalog_batch_metadata) {
                const row = result.batch_embeddings.find(
                  (row) => row.image === expected.image,
                );
                if (!row) throw new Error("INVALID_IMAGE_BATCH");
                if (row.error_code) {
                  if (
                    !/^[a-zA-Z0-9_]{1,64}$/.test(row.error_code) ||
                    row.embedding
                  )
                    throw new Error("INVALID_IMAGE_BATCH");
                  errors.push({
                    product_id: expected.metadata.product_id,
                    error: row.error_code,
                  });
                  continue;
                }
                rows.push({
                  ...expected.metadata,
                  embedding: normalizedImageVector(row.embedding),
                });
              }
              await this.vectors.upsertBatch(rows);
              job.index_summary = {
                indexed: rows.length,
                failed: errors.length,
                errors,
              };
            } else {
              if (
                result.model !== "openclip-vit-b32-laion2b" ||
                result.dimensions !== 512 ||
                !result.embedding
              )
                throw new Error("INVALID_IMAGE_VECTOR");
              if (job.catalog_metadata)
                await this.vectors.upsert({
                  ...job.catalog_metadata,
                  embedding: result.embedding,
                });
              const matches = await this.vectors.search(
                result.embedding,
                asJsonObject(job.worker.filters) as VisualSearchFilters,
              );
              job.matches = [];
              for (const match of matches)
                if (
                  await this.catalog.searchable(
                    match.product_id,
                    match.image_revision,
                  )
                )
                  job.matches.push({
                    product_id: match.product_id,
                    score: match.score,
                  });
            }
          }
          if (result.status === "failed") job.error = "AI_INFERENCE_FAILED";
        } catch (error) {
          if ((await this.repo.job(job.id))?.status === "cancelled") continue;
          if (error instanceof HttpError && error.status === 429) {
            await this.repo.transition(job.id, ["running"], { status: "queued" });
            await sleep(2500);
            continue;
          }
          job.status = "failed";
          // Only the deadline is a Timeout; a shutdown/deploy abort is an interruption and is not a user attempt.
          job.error = error instanceof HttpError ? error.code : controller.signal.aborted
            ? controller.signal.reason === "deadline" ? "AI_JOB_TIMEOUT" : "AI_JOB_INTERRUPTED"
            : "AI_INFERENCE_FAILED";
        } finally {
          clearTimeout(timeout);
          this.controllers.delete(job.id);
        }
        await this.repo.transition(job.id, ["running"], {
          status: job.status,
          gate: job.gate,
          error: job.error,
          result_url: job.result_url,
          matches: job.matches,
          index_summary: job.index_summary,
          processing_version: job.processing_version,
          // A studio job runs for minutes; its viewing window starts when it finishes, not when it was queued.
          ...(job.worker.mode === "studio" ? { expires_at: new Date(Date.now() + this.retentionSeconds() * 1000).toISOString() } : {}),
        });
      }
    } finally {
      this.pumping = false;
    }
  }
  /** Studio preview: run the 2D try-on once per studio pose (standing model first), publishing each pose as it finishes. */
  private async runStudio(job: AiJob, controller: AbortController): Promise<AiWorkerResult> {
    const ids = Array.isArray(job.worker.pose_ids) ? job.worker.pose_ids.map(String) : [];
    const labels = new Map(this.studioAssets().map((asset) => [asset.id, asset.label]));
    const poses: AiPoseRef[] = [];
    let standing: AiWorkerResult | undefined;
    for (const id of ids) {
      if (controller.signal.aborted) break;
      const first = standing === undefined;
      try {
        const result = await this.runPose(job, id, controller, first);
        // Only the standing pose decides the job's own status; later poses are best-effort extras.
        if (first && result.status !== "success") return result;
        if (result.status !== "success") continue;
        const file = await this.verifyPose(job, id, result);
        if (first) {
          await writeFile(join(job.directory, "result.png"), file, { mode: 0o600 });
          standing = result;
        }
        poses.push({ id, label: labels.get(id) || id });
        if (!(await this.repo.transition(job.id, ["running"], { poses: [...poses] }))) break;
      } catch (error) {
        if (first || controller.signal.aborted) throw error;
        console.error("AI_STUDIO_POSE_FAILED", job.id, id, (error as Error).message?.slice(0, 120));
      }
    }
    if (!standing) throw new Error(controller.signal.aborted ? "AI_JOB_TIMEOUT" : "AI_INFERENCE_FAILED");
    return standing;
  }

  /** One pose = one ordinary 2D try-on in its own directory; a busy worker is retried here, never by restarting the job. */
  private async runPose(job: AiJob, id: string, controller: AbortController, first: boolean): Promise<AiWorkerResult> {
    const directory = join(job.directory, "poses", id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await copyFile(join(job.directory, "garment.image"), join(directory, "garment.image"));
    await writeFile(join(directory, "person.image"), await this.catalog.studio(id), { mode: 0o600 });
    await writeFile(join(directory, "job.json"), JSON.stringify(job.worker), { mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      const own = new AbortController();
      // A slow standing pose fails the job as a timeout; a slow extra pose is only skipped.
      const timer = setTimeout(() => (first ? controller : own).abort("deadline"), 120_000);
      timer.unref();
      try {
        return await this.worker.run(directory, AbortSignal.any([controller.signal, own.signal]));
      } catch (error) {
        const busy = error instanceof HttpError && error.status === 429;
        if (!busy || controller.signal.aborted || attempt >= 3) throw error;
        await sleep(2500);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** A pose is published only with the same attested binding and a valid PNG as an ordinary try-on result. */
  private async verifyPose(job: AiJob, id: string, result: AiWorkerResult): Promise<Buffer> {
    if (!result.binding || result.binding.request_id !== job.id ||
        result.binding.product_id !== job.product_id || result.binding.variant_id !== job.variant_id) throw new Error("AI_WORKER_BINDING_MISMATCH");
    if (result.result_file !== "result.png" || result.gate?.valid !== true) throw new Error("INVALID_IMAGE_RESULT");
    const bytes = await this.repo.result({ ...job, directory: join(job.directory, "poses", id) });
    const output = sharp(bytes, { failOn: "warning", limitInputPixels: 20_000_000 });
    const metadata = await output.metadata();
    if (metadata.format !== "png" || (metadata.pages || 1) !== 1) throw new Error("INVALID_IMAGE_RESULT");
    await output.stats();
    return bytes;
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASKS: AiTask[] = [
  "image_quality",
  "image_embedding",
  "virtual_try_on",
  "product_image_enhance",
];
/** Job errors caused by the platform (restart/deploy, engine down, storage); they never consume a VTO-10 retry. */
const NOT_AN_ATTEMPT: Record<string, true> = { AI_JOB_INTERRUPTED: true, AI_ENGINE_UNAVAILABLE: true, AI_QUEUE_STORAGE_FAILED: true };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
/** Catalog adapter chooses shop garments server-side, never a caller-controlled remote URL. */
export interface AiCatalog {
  garment(
    productId: string,
    variantId: string,
  ): Promise<{ bytes: Buffer; category: string }>;
  studio(id: string): Promise<Buffer>;
  searchable(productId: string, imageRevision?: string): Promise<boolean>;
  image(productId: string): Promise<{
    bytes: Buffer;
    metadata: Omit<CatalogImageVector, "embedding">;
  }>;
  support?(
    productId: string,
    variantId?: string,
  ): Promise<{
    product_supported: boolean;
    variant_supported: boolean;
    garment_category?: string;
  }>;
}
/** Local serialized inference queue binds consent, assets, TTL and retries to the same principal. */
export class AiService {
  private pumping = false;
  private storageBlocked = false;
  private closed = false;
  private work?: Promise<void>;
  private maintenance?: ReturnType<typeof setInterval>;
  private readonly controllers = new Map<string, AbortController>();
  /** Last time each VTO job's product/variant was confirmed still tryable; a viewer fetches 24 frames at once. */
  private readonly supportCheckedAt = new Map<string, number>();
  private creating: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly repo: LocalAiRepository,
    private readonly worker: AiWorker,
    private readonly catalog: AiCatalog,
    private readonly vectors = new LocalImageVectorRepository(repo.root),
  ) {}
  private retentionSeconds(): number {
    const seconds = Number(process.env.AI_PRIVATE_TTL_SECONDS || 3600);
    if (!Number.isSafeInteger(seconds) || seconds < 1)
      throw new HttpError(503, "AI_RETENTION_NOT_CONFIGURED", "Chính sách lưu ảnh chưa hợp lệ.");
    return seconds;
  }
  private maxVtoAttempts(): number {
    const attempts = Number(process.env.AI_VTO_MAX_ATTEMPTS || 3);
    if (!Number.isSafeInteger(attempts) || attempts < 1)
      throw new HttpError(503, "AI_RETRY_NOT_CONFIGURED", "Chính sách thử lại chưa hợp lệ.");
    return attempts;
  }
    const { root, registry } = loadStudioAssets();
      const asset = asJsonObject(raw),
        file = asString(asset.file),
        path = resolve(root, file);
      if (asString(asset.gender) === "male") return [];
      return /^[a-zA-Z0-9_-]{1,64}$/.test(id) &&
        asset.licensed === true &&
        !!file &&
        path.startsWith(root + sep) &&
        existsSync(path)
        ? [
            {
              id,
              label: asString(asset.label) || id,
              gender: asString(asset.gender) || "unspecified",
              season: asString(asset.season) || undefined,
              occasion: asString(asset.occasion) || undefined,
              badge: asString(asset.badge) || undefined,
            },
          ]
        : [];
    });
    return {
      enabled,
      local_only: true,
      max_upload_bytes: 8 * 1024 * 1024,
      private_ttl_seconds: this.retentionSeconds(),
      max_vto_attempts: this.maxVtoAttempts(),
      studio_assets,
      tasks: TASKS.map((task) => ({
        task,
        enabled: allowed && this.worker.ready(task) && verified.includes(task),
        ...(allowed && this.worker.ready(task) && verified.includes(task)
          ? {}
          : { reason: "AI_ENGINE_UNAVAILABLE" }),
      })),
    };
  }
  /** Product capability validates shop configuration before asking customers to upload a personal photo. */
  async productCapabilities(
    productId: string,
    variantId?: string,
  ): Promise<{
    product_supported: boolean;
    variant_supported: boolean;
    garment_category?: string;
  }> {
    if (
      !UUID.test(productId) ||
      (variantId && !UUID.test(variantId)) ||
      !this.catalog.support
    )
      return { product_supported: false, variant_supported: false };
    return this.catalog.support(productId, variantId);
  }
  /** Refresh authenticated task readiness before accepting work; a stale observation cannot enable inference. */
  async refreshReadiness(): Promise<void> {
    await this.worker.refreshReadiness?.();
  }
  /** Preview only a registered licensed studio image before the customer consents to VTO. */
  async studioPreview(id: string): Promise<{ bytes: Buffer; mime: string }> {
    const bytes = await this.catalog.studio(id);
    if (bytes.length > 8 * 1024 * 1024)
      throw new HttpError(413, "IMAGE_TOO_LARGE", "Ảnh studio quá lớn.");
    const mime = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? "image/jpeg"
        : undefined;
    if (!mime)
      throw new HttpError(
        415,
        "INVALID_STUDIO_IMAGE",
        "Ảnh studio phải là PNG hoặc JPEG hợp lệ.",
      );
    return { bytes, mime };
  }
  private enabled(task?: AiTask): void {
    const capabilities = this.capabilities();
    if (
      !capabilities.enabled ||
      (task &&
        !capabilities.tasks.some((row) => row.task === task && row.enabled))
    )
      throw new HttpError(
        503,
        "AI_ENGINE_UNAVAILABLE",
        "Bộ xử lý AI chưa sẵn sàng.",
      );
  }
  /** Upload a bounded sniffed raster to a private one-hour asset, never public evidence storage. */
  async upload(
    owner: string,
    bytes: Buffer,
    mime: string,
  ): Promise<{ asset_id: string; expires_at: string }> {
    if (this.storageBlocked || process.env.AI_DISABLE === "true" || process.env.AI_ENABLE === "false" ||
        (process.env.NODE_ENV === "production" && process.env.AI_ENABLE !== "true")) {
      throw new HttpError(503, "AI_ENGINE_UNAVAILABLE", "Kho ảnh riêng chưa được bật.");
    }
    if (bytes.length < 12 || bytes.length > 8 * 1024 * 1024)
      throw new HttpError(413, "INVALID_IMAGE", "Ảnh phải dưới 8 MB.");
    const valid =
      (mime === "image/png" &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (mime === "image/jpeg" &&
        bytes[0] === 255 &&
        bytes[1] === 216 &&
        bytes[2] === 255) ||
      (mime === "image/webp" &&
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP");
    if (!valid)
      throw new HttpError(
        415,
        "INVALID_IMAGE",
        "Chỉ nhận ảnh JPEG, PNG hoặc WebP hợp lệ.",
      );
    try {
      const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: 20_000_000, animated: false });
      const metadata = await decoder.metadata();
      const expected = mime === "image/jpeg" ? "jpeg" : mime === "image/png" ? "png" : "webp";
      if (metadata.format !== expected || !metadata.width || !metadata.height || (metadata.pages || 1) !== 1) throw new Error("IMAGE_FORMAT");
      const raster = decoder.rotate();
      bytes = await (expected === "jpeg" ? raster.jpeg({ quality: 95 }) : expected === "png" ? raster.png() : raster.webp({ quality: 95 })).toBuffer();
      if (bytes.length > 8 * 1024 * 1024) throw new Error("IMAGE_SIZE");
    } catch { throw new HttpError(422, "INVALID_IMAGE", "Ảnh không đọc được hoặc vượt giới hạn điểm ảnh."); }
    await this.purgeExpired();
    const id = randomUUID();
    const asset: AiAsset = {
      id,
      owner,
      path: join(this.repo.root, "assets", `${id}.image`),
      mime,
      expires_at: new Date(Date.now() + this.retentionSeconds() * 1000).toISOString(),
    };
    await this.repo.saveAsset(asset, bytes);
    return { asset_id: id, expires_at: asset.expires_at };
  }
  private async asset(owner: string, value: unknown): Promise<AiAsset> {
    const id = asString(value);
    if (!UUID.test(id))
      throw new HttpError(400, "INVALID_ASSET", "Chọn ảnh trước khi xử lý.");
    const asset = await this.repo.asset(id);
    if (
      !asset ||
      asset.owner !== owner ||
      Date.parse(asset.expires_at) <= Date.now()
    )
      throw new HttpError(404, "ASSET_NOT_FOUND", "Ảnh không còn khả dụng.");
    return asset;
  }
  /** Read a current private asset for the same verified principal; no path or URL comes from the caller. */
  async readOwnedAsset(owner: string, id: string): Promise<{ bytes: Buffer; mime: string; expires_at: string }> {
    const asset = await this.asset(owner, id);
    return { bytes: await readFile(asset.path), mime: asset.mime, expires_at: asset.expires_at };
  }
  /** Erase an owner's source image at completion, including expired assets; foreign IDs are not exposed. */
  async deleteOwnedAsset(owner: string, id: string): Promise<void> {
    if (!UUID.test(id)) throw new HttpError(404, "ASSET_NOT_FOUND", "Ảnh không còn khả dụng.");
    const asset = await this.repo.asset(id);
    if (!asset || asset.owner !== owner) throw new HttpError(404, "ASSET_NOT_FOUND", "Ảnh không còn khả dụng.");
    await this.repo.deleteAsset(id);
  }
  /** Attest selected bytes from a successful owner-bound quality/enhancement job, never client measurements. */
  async approvalEvidence(owner: string, id: string, selection: EnhancementSelection): Promise<EnhancementEvidence> {
    const job = await this.owned(owner, id);
    if (job.status !== "success" || job.task !== (selection === "original" ? "image_quality" : "product_image_enhance") ||
        job.gate?.valid !== true || !job.processing_version) {
      throw new HttpError(422, "IMAGE_NOT_APPROVABLE", "Ảnh chưa có kết quả kiểm tra hợp lệ.");
    }
    const source = await readFile(join(job.directory, "input.image"));
    const bytes = selection === "original" ? source : await this.repo.result(job);
    const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: 20_000_000, animated: false });
    const metadata = await decoder.metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format || "") || (metadata.pages || 1) !== 1) throw new HttpError(422, "INVALID_IMAGE_EVIDENCE", "Không đọc được ảnh đã chọn.");
    await decoder.stats();
    return {
      bytes, mime: metadata.format === "jpeg" ? "image/jpeg" : metadata.format === "png" ? "image/png" : "image/webp",
      sourceRevision: createHash("sha256").update(source).digest("hex"), processingVersion: job.processing_version, gate: job.gate,
    };
  }
  /** Serialize enqueue to make duplicate submissions idempotent even while inputs are copied. */
  async create(
    owner: string,
    body: JsonObject,
    admin = false,
  ): Promise<AiJobView> {
    const pending = this.creating.then(() =>
      this.createOnce(owner, body, admin),
    );
    this.creating = pending.catch(() => undefined);
    return pending;
  }
  private async createOnce(
    owner: string,
    body: JsonObject,
    admin: boolean,
  ): Promise<AiJobView> {
    if (this.closed) throw new HttpError(503, "AI_ENGINE_UNAVAILABLE", "Bộ xử lý AI đang dừng.");
    await this.refreshReadiness();
    this.enabled();
    await this.purgeExpired();
    const task = asString(body.task) as AiTask;
    if (!TASKS.includes(task))
      throw new HttpError(400, "INVALID_TASK", "Tác vụ AI không được hỗ trợ.");
    this.enabled(task);
    if (task === "product_image_enhance" && !admin)
      throw new HttpError(
        403,
        "RBAC_DENIED",
        "Chỉ quản lý sản phẩm được chỉnh ảnh.",
      );
    if (body.consent !== true || body.confirmed !== true)
      throw new HttpError(
        400,
        "CONSENT_REQUIRED",
        "Cần đồng ý xử lý ảnh và xác nhận ảnh xem trước.",
      );
    const key = asString(body.idempotency_key);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key))
      throw new HttpError(
        400,
        "IDEMPOTENCY_REQUIRED",
        "Thiếu mã yêu cầu hợp lệ.",
      );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(canonical(payload)))
      .digest("hex");
    const jobs = await this.repo.jobs();
    const duplicate = jobs.find(
      (job) => job.owner === owner && job.idempotency_key === key,
    );
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint)
        throw new HttpError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Yêu cầu đã thay đổi. Vui lòng tạo yêu cầu mới.",
        );
      return this.view(duplicate);
    }
    const active = jobs.find(
      (job) =>
        job.owner === owner &&
        job.fingerprint === fingerprint &&
        ["queued", "running"].includes(job.status),
    );
    if (active) return this.view(active);
    // VTO-10: infrastructure faults (restart, engine down, storage) are the shop's failure, not a user attempt.
    const attempts = task === "virtual_try_on"
      ? jobs.filter(job => job.owner === owner && job.fingerprint === fingerprint && !NOT_AN_ATTEMPT[job.error ?? ""])
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
      : [];
    if (task === "virtual_try_on" && attempts.length >= this.maxVtoAttempts())
      throw new HttpError(429, "AI_RETRY_LIMIT", "Đã đạt giới hạn thử lại cho ảnh và sản phẩm này.");
    if (
      jobs.filter(
        (job) =>
          job.owner === owner && ["queued", "running"].includes(job.status),
      ).length >= 2
    )
      throw new HttpError(
        429,
        "AI_QUEUE_FULL",
        "Hãy đợi tác vụ hiện tại hoàn tất.",
      );
    const id = randomUUID(),
      directory = join(this.repo.root, "jobs", id);
    const worker: Record<string, unknown> = {
      task,
      request_id: id,
      product_id: "",
      variant_id: "",
      consent: true,
      confirmed: true,
    };
    let catalog_metadata: Omit<CatalogImageVector, "embedding"> | undefined;
    let catalog_batch_metadata: AiJob["catalog_batch_metadata"];
    const inputErrors: Array<{ product_id: string; error: string }> = [];
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      if (task === "virtual_try_on") {
        const productId = asString(body.product_id),
          variantId = asString(body.variant_id);
        if (
          !UUID.test(productId) ||
          !UUID.test(variantId) ||
          !["personal", "studio"].includes(asString(body.mode))
        )
          throw new HttpError(
            400,
            "INVALID_PRODUCT",
            "Chọn sản phẩm, biến thể và chế độ thử đồ hợp lệ.",
          );
        const support = await this.productCapabilities(productId, variantId);
        if (!support.product_supported || !support.variant_supported) throw new HttpError(422, "VTO_PRODUCT_UNAVAILABLE", "Sản phẩm hoặc biến thể chưa hỗ trợ thử đồ.");
        const garment = await this.catalog.garment(productId, variantId);
        await writeFile(join(directory, "garment.image"), garment.bytes, {
          mode: 0o600,
        });
          await copyFile(
            (await this.asset(owner, body.person_asset_id)).path,
            join(directory, "person.image"),
          );
        Object.assign(worker, {
          mode: body.mode,
          garment_category: garment.category,
          product_id: productId,
          variant_id: variantId,
          garment_photo_type: "flat-lay",
          garment: "garment.image",
          person: "person.image",
        });
      } else {
        if (body.catalog_index === true) {
          if (!admin || task !== "image_embedding")
            throw new HttpError(
              403,
              "RBAC_DENIED",
              "Chỉ quản lý được lập chỉ mục ảnh shop.",
            );
          if (Array.isArray(body.catalog_product_ids)) {
            const ids = body.catalog_product_ids;
            if (
              ids.length < 1 ||
              ids.length > 16 ||
              new Set(ids).size !== ids.length ||
              ids.some((id) => typeof id !== "string" || !UUID.test(id))
            )
              throw new HttpError(
                400,
                "INVALID_CATALOG_BATCH",
                "Chọn tối đa 16 sản phẩm hợp lệ.",
              );
            catalog_batch_metadata = [];
            let size = 0;
            for (let i = 0; i < ids.length; i++) {
              const productId = String(ids[i]);
              try {
                const catalogImage = await this.catalog.image(productId);
                size += catalogImage.bytes.length;
                if (size > 32 * 1024 * 1024)
                  throw new HttpError(
                    413,
                    "BATCH_TOO_LARGE",
                    "Nhóm ảnh quá lớn.",
                  );
                const image = `catalog-${i}.image`;
                await writeFile(join(directory, image), catalogImage.bytes, {
                  mode: 0o600,
                });
                catalog_batch_metadata.push({
                  image,
                  metadata: catalogImage.metadata,
                });
              } catch (error) {
                if (
                  error instanceof HttpError &&
                  error.code === "BATCH_TOO_LARGE"
                )
                  throw error;
                inputErrors.push({
                  product_id: productId,
                  error:
                    error instanceof HttpError
                      ? error.code
                      : "CATALOG_IMAGE_UNAVAILABLE",
                });
              }
            }
            if (!catalog_batch_metadata.length)
              throw new HttpError(
                422,
                "CATALOG_BATCH_EMPTY",
                "Không có ảnh shop khả dụng trong nhóm.",
              );
            worker.images = catalog_batch_metadata.map((row) => row.image);
          } else {
            if (!UUID.test(asString(body.product_id)))
              throw new HttpError(
                400,
                "INVALID_PRODUCT",
                "Chọn sản phẩm hợp lệ.",
              );
            const catalogImage = await this.catalog.image(
              asString(body.product_id),
            );
            await writeFile(
              join(directory, "input.image"),
              catalogImage.bytes,
              { mode: 0o600 },
            );
            catalog_metadata = catalogImage.metadata;
          }
        } else
          await copyFile(
            (await this.asset(owner, body.image_asset_id)).path,
            join(directory, "input.image"),
          );
        if (!worker.images) worker.image = "input.image";
        worker.person_check = body.person_check === true;
        if (task === "product_image_enhance") {
          if (
            body.background !== undefined &&
            !["white", "transparent"].includes(asString(body.background))
          )
            throw new HttpError(
              400,
              "INVALID_BACKGROUND",
              "Nền ảnh không hợp lệ.",
            );
          worker.options = {
            background: body.background,
            brightness: body.brightness === true,
            sharpness: body.sharpness === true,
          };
        }
      }
      const now = new Date().toISOString();
      const job: AiJob = {
        id,
        task,
        status: "queued",
        owner,
        idempotency_key: key,
        fingerprint,
        directory,
        worker,
        ...(task === "virtual_try_on" ? { product_id: asString(body.product_id), variant_id: asString(body.variant_id) } : {}),
        ...(task === "virtual_try_on" ? {
          attempt: attempts.length + 1,
          retry_of: attempts.at(-1)?.id,
        } : {}),
        catalog_metadata,
        catalog_batch_metadata,
        ...(inputErrors.length
          ? {
              index_summary: {
                indexed: 0,
                failed: inputErrors.length,
                errors: inputErrors,
              },
            }
          : {}),
        created_at: now,
        expires_at: new Date(Date.now() + this.retentionSeconds() * 1000).toISOString(),
      };
      // Query filters are private worker metadata and never customer image embeddings persisted in the catalog.
      const filters = asJsonObject(body.filters);
      for (const [key, value] of Object.entries(filters)) {
        if (
          ![
            "category_id",
            "style_tags",
            "color_tone",
            "occasions",
            "suitable_body_shapes",
            "product_ids",
          ].includes(key) ||
          (["category_id", "color_tone"].includes(key)
            ? typeof value !== "string" || value.length > 100
            : !Array.isArray(value) ||
              value.length > (key === "product_ids" ? 500 : 12) ||
              value.some((v) => typeof v !== "string" || v.length > 100)) ||
          (key === "product_ids" &&
            Array.isArray(value) &&
            value.some(
              (v) =>
                typeof v !== "string" ||
                !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
                  v,
                ),
            ))
        ) {
          throw new HttpError(
            400,
            "INVALID_FILTERS",
            "Bộ lọc tìm kiếm không hợp lệ.",
          );
        }
      }
      worker.filters = filters;
      await writeFile(join(directory, "job.json"), JSON.stringify(worker), {
        mode: 0o600,
      });
      if (this.closed) throw new HttpError(503, "AI_ENGINE_UNAVAILABLE", "Bộ xử lý AI đang dừng.");
      await this.repo.saveJob(job);
      this.startPump();
      return this.view(job);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  private view(job: AiJob): AiJobView {
    return {
      id: job.id,
      task: job.task,
      status: job.status,
      created_at: job.created_at,
      expires_at: job.expires_at,
      ...(job.task === "virtual_try_on" ? { product_id: job.product_id, variant_id: job.variant_id } : {}),
      ...(job.attempt ? { attempt: job.attempt, retry_of: job.retry_of } : {}),
      ...(job.result_url ? { result_url: job.result_url } : {}),
      ...(job.gate ? { gate: job.gate } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.matches ? { matches: job.matches } : {}),
      ...(job.index_summary ? { index_summary: job.index_summary } : {}),
    };
  }
  private async owned(owner: string, id: string): Promise<AiJob> {
    if (!UUID.test(id))
      throw new HttpError(404, "JOB_NOT_FOUND", "Không tìm thấy tác vụ.");
    const job = await this.repo.job(id);
    if (!job || job.owner !== owner || Date.parse(job.expires_at) <= Date.now())
      throw new HttpError(404, "JOB_NOT_FOUND", "Không tìm thấy tác vụ.");
    return job;
  }
  /** Return only owner-authorized state; polling also resumes a stopped local queue. */
  async get(owner: string, id: string): Promise<AiJobView> {
    if (this.storageBlocked) throw new HttpError(503, "AI_QUEUE_STORAGE_FAILED", "Kho tác vụ tạm thời không khả dụng.");
    const job = await this.owned(owner, id);
    this.startPump();
    return this.view(job);
  }
  /** Recover a lost create response using the same owner-scoped idempotency key; no global job listing. */
  async getByKey(owner: string, key: string): Promise<AiJobView> {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key))
      throw new HttpError(400, "INVALID_KEY", "Mã yêu cầu không hợp lệ.");
    const job = (await this.repo.jobs()).find(
      (row) =>
        row.owner === owner &&
        row.idempotency_key === key &&
        Date.parse(row.expires_at) > Date.now(),
    );
    if (!job)
      throw new HttpError(404, "JOB_NOT_FOUND", "Không tìm thấy tác vụ.");
    return this.view(job);
  }
  /** Cancellation never publishes a late image after a worker returns. */
  async cancel(owner: string, id: string): Promise<AiJobView> {
    const job = await this.owned(owner, id);
    const updated = await this.repo.transition(id, ["queued", "running"], {
      status: "cancelled",
    });
    if (updated) this.controllers.get(id)?.abort();
    return this.view(updated || job);
  }
  /** Serve private bounded output bytes only for a successfully completed owned job. */
  async result(owner: string, id: string): Promise<Buffer> {
    const job = await this.owned(owner, id);
    if (this.storageBlocked) throw new HttpError(503, "AI_QUEUE_STORAGE_FAILED", "Kho tác vụ tạm thời không khả dụng.");
    if (job.task === "virtual_try_on") await this.requireVtoSelectionSupported(job);
    if (job.status !== "success" || !job.result_url)
      throw new HttpError(
        409,
        "RESULT_UNAVAILABLE",
        "Ảnh kết quả chưa sẵn sàng.",
      );
    return this.repo.result(job);
  }
  async resultFile(owner: string, id: string, name: string): Promise<Buffer> {
    const job = await this.owned(owner, id);
    if (this.storageBlocked) throw new HttpError(503, "AI_QUEUE_STORAGE_FAILED", "Kho tác vụ tạm thời không khả dụng.");
    if (job.task === "virtual_try_on") await this.requireVtoSelectionSupported(job, 30_000);
    return this.repo.resultFile(job, name);
  }
  /**
   * A VTO output is served only while its exact product/variant is still offered for try-on. `reuseMs` lets the
   * frame burst of one viewer share a single catalog check instead of 2 reads per frame.
   */
  private async requireVtoSelectionSupported(job: AiJob, reuseMs = 0): Promise<void> {
    const checkedAt = this.supportCheckedAt.get(job.id);
    if (reuseMs && checkedAt && Date.now() - checkedAt < reuseMs) return;
    const support = await this.productCapabilities(job.product_id!, job.variant_id);
    if (!support.product_supported || !support.variant_supported) {
      this.supportCheckedAt.delete(job.id);
      throw new HttpError(409, "VTO_PRODUCT_UNAVAILABLE", "Sản phẩm hoặc biến thể không còn hỗ trợ thử đồ.");
    }
    for (const [id, at] of this.supportCheckedAt) if (Date.now() - at >= 30_000) this.supportCheckedAt.delete(id);
    this.supportCheckedAt.set(job.id, Date.now());
  }
  /** Remove expired jobs/assets, never the directory of a job a worker is still writing into. */
  private purgeExpired(): Promise<void> {
    return this.repo.purge(Date.now(), new Set(this.controllers.keys()));
  }
  /** After a restart: interrupted running work fails (not a user attempt); queued work and pending 360° stages resume. */
  async recover(): Promise<void> {
    await this.purgeExpired();
    for (const job of await this.repo.jobs()) {
      if (job.status === "running")
        await this.repo.transition(job.id, ["running"], {
          status: "failed",
          error: "AI_JOB_INTERRUPTED",
        });
      // A pending 360° stage is left pending: nothing runs in a fresh process, and the pump picks it up once the
      // 2D queue is empty (or marks it failed when the worker cannot render it).
    }
    this.startPump();
    if (!this.maintenance) {
      this.maintenance = setInterval(
        () => void this.purgeExpired().catch(() => undefined),
        60_000,
      );
      this.maintenance.unref();
    }
  }
  /** Stop maintenance when a local test/server closes; does not claim remote inference stopped. */
  async close(): Promise<void> {
    clearInterval(this.maintenance);
    this.closed = true;
    await this.creating;
    for (const controller of this.controllers.values()) controller.abort("shutdown");
    await this.work;
  }
  private startPump(): void {
    if (this.closed || this.pumping) return;
    this.work = this.pump().catch(() => {
      this.storageBlocked = true;
      console.error("AI_QUEUE_STORAGE_FAILED");
    });
  }
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      await this.refreshReadiness();
      while (!this.closed) {
        await this.refreshReadiness();
        const live = (await this.repo.jobs()).filter((row) => Date.parse(row.expires_at) > Date.now());
        const job = live
          .filter((row) => row.status === "queued")
          .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
        if (!this.worker.ready(job.task)) {
          await this.repo.transition(job.id, ["queued"], { status: "failed", error: "AI_ENGINE_UNAVAILABLE" });
          continue;
        }
        if (
          !(await this.repo.transition(job.id, ["queued"], {
            status: "running",
          }))
        )
          continue;
        job.status = "running";
        const controller = new AbortController();
        this.controllers.set(job.id, controller);
        timeout.unref();
        try {
          if (controller.signal.aborted) throw new Error("AI_JOB_TIMEOUT");
          const current = await this.repo.job(job.id);
          if (current?.status === "cancelled") continue;
          if (job.task === "virtual_try_on") {
            if (!result.binding || result.binding.request_id !== job.id ||
                result.binding.product_id !== job.product_id || result.binding.variant_id !== job.variant_id) throw new Error("AI_WORKER_BINDING_MISMATCH");
            const support = await this.productCapabilities(job.product_id!, job.variant_id);
            if (!support.product_supported || !support.variant_supported) throw new Error("VTO_PRODUCT_UNAVAILABLE");
          }
          job.status = result.status;
          job.gate = result.gate;
          job.processing_version = result.processing_version;
          if (result.status === "success" &&
              ["virtual_try_on", "product_image_enhance"].includes(job.task) &&
              (result.result_file !== "result.png" || result.gate?.valid !== true))
            throw new Error("INVALID_IMAGE_RESULT");
          if (
            result.result_file === "result.png" &&
            result.status === "success"
          ) {
            const output = sharp(await this.repo.result(job), { failOn: "warning", limitInputPixels: 20_000_000 });
            const metadata = await output.metadata();
            if (metadata.format !== "png" || (metadata.pages || 1) !== 1) throw new Error("INVALID_IMAGE_RESULT");
            await output.stats();
            job.result_url = `jobs/${job.id}/result`;
          }
          if (job.task === "image_embedding" && result.status === "success") {
            if (job.catalog_batch_metadata) {
              if (
                result.model !== "openclip-vit-b32-laion2b" ||
                result.dimensions !== 512 ||
                !Array.isArray(result.batch_embeddings) ||
                result.batch_embeddings.length !==
                  job.catalog_batch_metadata.length ||
                new Set(result.batch_embeddings.map((row) => row.image))
                  .size !== result.batch_embeddings.length
              )
                throw new Error("INVALID_IMAGE_BATCH");
              const rows: CatalogImageVector[] = [];
              const errors = job.index_summary?.errors || [];
              for (const expected of job.catalog_batch_metadata) {
                const row = result.batch_embeddings.find(
                  (row) => row.image === expected.image,
                );
                if (!row) throw new Error("INVALID_IMAGE_BATCH");
                if (row.error_code) {
                  if (
                    !/^[a-zA-Z0-9_]{1,64}$/.test(row.error_code) ||
                    row.embedding
                  )
                    throw new Error("INVALID_IMAGE_BATCH");
                  errors.push({
                    product_id: expected.metadata.product_id,
                    error: row.error_code,
                  });
                  continue;
                }
                rows.push({
                  ...expected.metadata,
                  embedding: normalizedImageVector(row.embedding),
                });
              }
              await this.vectors.upsertBatch(rows);
              job.index_summary = {
                indexed: rows.length,
                failed: errors.length,
                errors,
              };
            } else {
              if (
                result.model !== "openclip-vit-b32-laion2b" ||
                result.dimensions !== 512 ||
                !result.embedding
              )
                throw new Error("INVALID_IMAGE_VECTOR");
              if (job.catalog_metadata)
                await this.vectors.upsert({
                  ...job.catalog_metadata,
                  embedding: result.embedding,
                });
              const matches = await this.vectors.search(
                result.embedding,
                asJsonObject(job.worker.filters) as VisualSearchFilters,
              );
              job.matches = [];
              for (const match of matches)
                if (
                  await this.catalog.searchable(
                    match.product_id,
                    match.image_revision,
                  )
                )
                  job.matches.push({
                    product_id: match.product_id,
                    score: match.score,
                  });
            }
          }
          if (result.status === "failed") job.error = "AI_INFERENCE_FAILED";
        } catch (error) {
          if ((await this.repo.job(job.id))?.status === "cancelled") continue;
          if (error instanceof HttpError && error.status === 429) {
            await this.repo.transition(job.id, ["running"], { status: "queued" });
            await sleep(2500);
            continue;
          }
          job.status = "failed";
          // Only the deadline is a Timeout; a shutdown/deploy abort is an interruption and is not a user attempt.
          job.error = error instanceof HttpError ? error.code : controller.signal.aborted
            ? controller.signal.reason === "deadline" ? "AI_JOB_TIMEOUT" : "AI_JOB_INTERRUPTED"
            : "AI_INFERENCE_FAILED";
        } finally {
          clearTimeout(timeout);
          this.controllers.delete(job.id);
        }
        await this.repo.transition(job.id, ["running"], {
          status: job.status,
          gate: job.gate,
          error: job.error,
          result_url: job.result_url,
          matches: job.matches,
          index_summary: job.index_summary,
          processing_version: job.processing_version,
        });
      }
    } finally {
      this.pumping = false;
    }
  }
    }
  }

    }
  }
}
