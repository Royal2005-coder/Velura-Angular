import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AiTask, AiWorker, AiWorkerResult } from "./ai-types.js";

const VERSION = "velura-worker-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATHS: Record<AiTask, string> = {
  image_quality: "/ai/quality", image_embedding: "/embed/image",
  product_image_enhance: "/ai/enhance", virtual_try_on: "/ai/try-on",
};

/** Private request identity echoed in JSON and image response headers. */
export interface ClusterWorkerBinding {
  schema_version: string;
  request_id: string;
  task: AiTask;
  product_id: string;
  variant_id: string;
  image_id: string;
}

type BoundResult = AiWorkerResult & {
  binding: ClusterWorkerBinding;
  schema_version: string;
  preprocessing_version: string;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI_WORKER_SCHEMA");
  return value as Record<string, unknown>;
}

function checkBinding(value: unknown, expected: ClusterWorkerBinding): void {
  const data = object(value);
  for (const field of Object.keys(expected) as Array<keyof ClusterWorkerBinding>) {
    if (data[field] !== expected[field]) throw new Error("AI_WORKER_BINDING_MISMATCH");
  }
}

function headerJson(response: Response, name: string): unknown {
  const value = response.headers.get(name);
  if (!value || value.length > 8192 || !/^[A-Za-z0-9_=-]+$/.test(value)) throw new Error("AI_WORKER_HEADER");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
}

async function boundedBytes(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body) throw new Error("AI_WORKER_EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new Error("AI_WORKER_RESPONSE_SIZE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, length);
}

/** Authenticated, version-bound GPU worker; readiness is observed, never inferred from NODE_ENV. */
export class ClusterAiWorker implements AiWorker {
  private readonly endpoint: string;
  private readonly key: string;
  private readonly http: typeof fetch;
  private tasks: Partial<Record<AiTask, boolean>> = {};
  private observedAt = 0;
  private refreshing?: Promise<void>;

  constructor(endpoint?: string, key?: string, http: typeof fetch = fetch) {
    this.endpoint = (endpoint || process.env.AI_CLUSTER_ENDPOINT || "http://ai-clip.ai.svc:8000").replace(/\/$/, "");
    this.key = key ?? process.env.AI_WORKER_KEY ?? "";
    this.http = http;
  }

  /** Exact worker schema used by parent engine output validation. */
  supportedVersion(): string { return VERSION; }

  /** Capability is available only while a recent authenticated dependency observation remains valid. */
  ready(task?: AiTask): boolean {
    if (process.env.AI_DISABLE === "true" || this.key.length < 32 || Date.now() - this.observedAt > 30_000) return false;
    return task ? this.tasks[task] === true : this.tasks.virtual_try_on === true;
  }

  /** Refresh task-specific health; unavailable GPU/weights never enables VTO or fake CPU fallback. */
  async refreshReadiness(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.observe();
    try { await this.refreshing; } finally { this.refreshing = undefined; }
  }

  private async observe(): Promise<void> {
    const observed: Partial<Record<AiTask, boolean>> = {};
    let observedAt = 0;
    try {
      if (this.key.length < 32 || process.env.AI_DISABLE === "true") return;
      const response = await this.http(`${this.endpoint}/health`, {
        headers: { Authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 200 && response.status !== 503) return;
      const health = object(JSON.parse((await boundedBytes(response, 16_384)).toString("utf8")) as unknown);
      if (health.schema_version === VERSION) {
        const tasks = object(health.tasks);
        observed.image_quality = tasks.image_quality === true;
        const loaded = response.ok && health.ready === true;
        observed.image_embedding = loaded && tasks.image_embedding === true && health.embedding_model === "openclip-vit-b32-laion2b" && health.dimensions === 512;
        observed.product_image_enhance = loaded && tasks.product_image_enhance === true;
        observed.virtual_try_on = loaded && tasks.virtual_try_on === true && health.gpu === true && health.dtype === "bfloat16" && health.vton_model === "fashn-vton-1.5-maskless-flatlay" && health.segmentation_free === true && Array.isArray(health.garment_photo_types) && health.garment_photo_types.length === 1 && health.garment_photo_types[0] === "flat-lay";
      } else if (health.status === "healthy" && Array.isArray(health.features)) {
        observed.image_quality = health.features.includes("image_quality");
        observed.image_embedding = health.features.includes("image_embedding") && health.vector_dimensions === 512;
        observed.product_image_enhance = health.features.includes("product_image_enhance");
        observed.virtual_try_on = health.features.includes("virtual_try_on") && !!health.gpu;
      }
      observedAt = Date.now();
    } catch {
      // Failed observations revoke readiness; an in-flight refresh never erases a fresh good observation.
    } finally {
      this.tasks = observed;
      this.observedAt = observedAt;
    }
  }

  /** Execute an authorized job, verifying every returned identifier before publishing result bytes. */
  async run(directory: string, signal: AbortSignal): Promise<AiWorkerResult> {
    const job = object(JSON.parse(await readFile(join(directory, "job.json"), "utf8")) as unknown);
    const task = String(job.task) as AiTask;
    if (!(task in PATHS)) throw new Error("UNKNOWN_AI_TASK");
    await this.refreshReadiness();
    if (!this.ready(task)) throw new Error("AI_WORKER_UNAVAILABLE");
    const requestId = String(job.request_id ?? "");
    const productId = String(job.product_id ?? "");
    const variantId = String(job.variant_id ?? "");
    if (!UUID.test(requestId) || (productId && !UUID.test(productId)) || (variantId && (!productId || !UUID.test(variantId)))) throw new Error("AI_WORKER_INVALID_BINDING");
    if (task === "virtual_try_on" && (!productId || !variantId || job.garment_photo_type !== "flat-lay")) throw new Error("AI_WORKER_FLATLAY_BINDING_REQUIRED");

    const execute = async (imageName: string): Promise<BoundResult> => {
      if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(imageName) || imageName === "." || imageName === "..") throw new Error("AI_WORKER_IMAGE_PATH");
      const binding: ClusterWorkerBinding = { schema_version: VERSION, request_id: requestId, task, product_id: productId, variant_id: variantId, image_id: imageName };
      const form = new FormData();
      form.append("binding", JSON.stringify(binding));
      const add = async (field: string, name: string, maximum: number) => {
        const bytes = await readFile(join(directory, name));
        if (!bytes.length || bytes.length > maximum) throw new Error("AI_WORKER_IMAGE_SIZE");
        form.append(field, new Blob([bytes]), name);
      };
      if (task === "virtual_try_on") {
        await add("person", "person.image", 8 * 1024 * 1024);
        await add("garment", "garment.image", 5 * 1024 * 1024);
        form.append("category", String(job.garment_category));
        form.append("garment_photo_type", "flat-lay");
      } else {
        await add("file", imageName, 8 * 1024 * 1024);
        if (task === "image_quality") form.append("person_check", job.person_check === true ? "true" : "false");
        if (task === "product_image_enhance") {
          const options = job.options ? object(job.options) : {};
          form.append("background", String(options.background || "white"));
          form.append("brightness", options.brightness === true ? "true" : "false");
          form.append("sharpness", options.sharpness === true ? "true" : "false");
        }
      }
      const response = await this.http(`${this.endpoint}${PATHS[task]}`, {
        method: "POST", headers: { Authorization: `Bearer ${this.key}` }, body: form,
        signal: AbortSignal.any([signal, AbortSignal.timeout(190_000)]),
      });
      if (!response.ok) throw new Error(`AI_WORKER_HTTP_${response.status}`);
      const bindingHeader = response.headers.get("x-ai-binding");
      if (bindingHeader) checkBinding(headerJson(response, "x-ai-binding"), binding);
      const bytes = await boundedBytes(response, 8 * 1024 * 1024);
      const binary = response.headers.get("content-type")?.split(";")[0] === "image/png";
      const resultHeader = response.headers.get("x-ai-result");
      const data = object(binary ? (resultHeader ? headerJson(response, "x-ai-result") : { status: "success", gate: { valid: true, metrics: {} } }) : JSON.parse(bytes.toString("utf8")) as unknown);
      if (!binary && bindingHeader) checkBinding(data, binding);
      const rawStatus = String(data.status || (data.valid === true ? "success" : data.valid === false ? "validation_failed" : binary ? "success" : "failed"));
      if (!["success", "validation_failed", "failed"].includes(rawStatus)) throw new Error("AI_WORKER_STATUS");
      const result: BoundResult = { status: rawStatus as AiWorkerResult["status"], binding, schema_version: VERSION, preprocessing_version: "velura-measured-1", processing_version: `${String(data.model || "gpu-quality")}:velura-measured-1` };
      result.gate = object(data.gate || data);
      if (typeof data.model === "string") result.model = data.model;
      if (binary) {
        if (!["virtual_try_on", "product_image_enhance"].includes(task) || data.status !== "success" || bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("AI_WORKER_IMAGE_SCHEMA");
        if (!result.gate || result.gate.valid !== true) throw new Error("AI_WORKER_OUTPUT_GATE");
        await writeFile(join(directory, "result.png"), bytes, { mode: 0o600 });
        result.result_file = "result.png";
      } else if (task === "image_embedding" && data.status === "success") {
        const embedding = data.embedding;
        if (data.model !== "openclip-vit-b32-laion2b" || data.dimensions !== 512 || !Array.isArray(embedding) || embedding.length !== 512 || embedding.some(v => typeof v !== "number" || !Number.isFinite(v))) throw new Error("AI_WORKER_EMBEDDING_SCHEMA");
        const norm = Math.sqrt(embedding.reduce((sum: number, v: number) => sum + v * v, 0));
        if (Math.abs(norm - 1) > .01) throw new Error("AI_WORKER_EMBEDDING_NORMALIZATION");
        result.embedding = embedding as number[];
        result.dimensions = 512;
      } else if (data.status === "success" && task !== "image_quality") throw new Error("AI_WORKER_IMAGE_MISSING");
      return result;
    };

    if (task === "image_embedding" && Array.isArray(job.images) && job.images.length) {
      const batch: NonNullable<AiWorkerResult["batch_embeddings"]> = [];
      for (const name of job.images) {
        if (signal.aborted) throw signal.reason;
        if (typeof name !== "string") throw new Error("AI_WORKER_IMAGE_PATH");
        try {
          const result = await execute(name);
          batch.push(result.embedding ? { image: name, embedding: result.embedding } : { image: name, error_code: "EMBEDDING_FAILED" });
        } catch (error) {
          if (signal.aborted) throw error;
          batch.push({ image: name, error_code: "EMBEDDING_FAILED" });
        }
      }
      return { status: batch.some(row => row.embedding) ? "success" : "failed", model: "openclip-vit-b32-laion2b", dimensions: 512, batch_embeddings: batch };
    }
    return execute(task === "virtual_try_on" || job.person ? "person.image" : "input.image");
  }
}
