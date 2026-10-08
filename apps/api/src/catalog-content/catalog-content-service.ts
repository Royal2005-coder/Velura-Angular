import { config } from "../config.js";
import { generateGeminiText } from "../gemini-client.js";
import { HttpError } from "../http.js";
import { requirePermission } from "../rbac.js";
import { asJsonObject, type AuthContext } from "../types.js";
import type { CatalogBatch, CatalogContentRepository, CatalogDraft, CatalogSource, CatalogWork } from "./catalog-content-types.js";
import { CATALOG_PROMPT, CATALOG_SCHEMA, catalogPrompt, validateCatalogContent } from "./catalog-content-validation.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new HttpError(422, "ID_INVALID", "A valid identifier is required");
  return value;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new HttpError(422, "VERSION_REQUIRED", "expectedVersion is required");
  return Number(value);
}
function actor(context: AuthContext | undefined): string {
  if (!context) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
  requirePermission(context, "products", "write");
  if (!["super_admin", "admin_operator_sanpham"].includes(context.roleCode)) throw new HttpError(403, "RBAC_DENIED", "Product admin access is required");
  return id(context.profile?.user_id);
}

/** Product-admin-only durable generation, immutable drafts, explicit review and atomic versioned publish. */
export class CatalogContentService {
  private timer: NodeJS.Timeout | undefined;
  private readonly workers = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly repository: CatalogContentRepository, private readonly generate: typeof generateGeminiText = generateGeminiText, private readonly model = config.geminiModel || config.geminiStylistModel) {}

  /** Creates a bounded bulk batch; retries with the same key recover exactly the original source snapshots. */
  async enqueue(context: AuthContext | undefined, input: unknown): Promise<CatalogBatch> {
    const owner = actor(context);
    const body = asJsonObject(input);
    if (Object.keys(body).some(k => !["products", "idempotencyKey"].includes(k)) || typeof body.idempotencyKey !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.idempotencyKey) || !Array.isArray(body.products) || !body.products.length || body.products.length > 50) throw new HttpError(422, "BATCH_INVALID", "Supply 1–50 products and an idempotency key");
    const products = body.products.map((value: unknown) => {
      const p = asJsonObject(value);
      if (Object.keys(p).some(k => !["productId", "expectedVersion"].includes(k))) throw new HttpError(422, "BATCH_INVALID", "Unsupported product field");
      return { productId: id(p.productId), expectedVersion: version(p.expectedVersion) };
    }).sort((a, b) => a.productId.localeCompare(b.productId));
    if (new Set(products.map(p => p.productId)).size !== products.length) throw new HttpError(422, "BATCH_INVALID", "Duplicate products are not allowed");
    const result = await this.repository.execute<CatalogBatch>(owner, "enqueue", { products, idempotencyKey: body.idempotencyKey });
    this.kick();
    return result;
  }

  /** Reads item-level progress and settles expired jobs to finite failures. */
  batch(context: AuthContext | undefined, batchId: string): Promise<CatalogBatch> {
    return this.repository.execute(actor(context), "batch", { id: id(batchId) });
  }
  /** Lists recent drafts without replacing any live content. */
  drafts(context: AuthContext | undefined, productId: string): Promise<{ drafts: CatalogDraft[]; source: CatalogSource }> {
    return this.repository.execute(actor(context), "drafts", { productId: id(productId) });
  }
  /** Reads the immutable source and generation before editing or making a review decision. */
  draft(context: AuthContext | undefined, draftId: string): Promise<CatalogDraft> {
    return this.repository.execute(actor(context), "draft", { id: id(draftId) });
  }
  /** Revalidates edits against original evidence; editing an approval returns it to unapproved draft state. */
  async review(context: AuthContext | undefined, draftId: string, input: unknown): Promise<CatalogDraft> {
    const owner = actor(context), body = asJsonObject(input);
    if (Object.keys(body).some(k => !["content", "decision", "expectedVersion"].includes(k)) || !["save", "approve", "reject"].includes(String(body.decision))) throw new HttpError(422, "REVIEW_INVALID", "Choose save, approve or reject");
    const draft = await this.repository.execute<CatalogDraft>(owner, "draft", { id: id(draftId) });
    const content = body.decision === "reject" ? null : validateCatalogContent(body.content, draft.source);
    return this.repository.execute(owner, "review", { id: draftId, expectedVersion: version(body.expectedVersion), decision: body.decision, content });
  }
  /** Publishes only a separately approved draft; DB locks product/draft and compares source revision plus both versions. */
  publish(context: AuthContext | undefined, draftId: string, input: unknown): Promise<CatalogDraft> {
    const body = asJsonObject(input);
    if (Object.keys(body).some(k => !["expectedVersion", "expectedDraftVersion"].includes(k))) throw new HttpError(422, "PUBLISH_INVALID", "Unsupported publish field");
    return this.repository.execute(actor(context), "publish", { id: id(draftId), expectedVersion: version(body.expectedVersion), expectedDraftVersion: version(body.expectedDraftVersion) });
  }
  /** Records manually verified material/features/styling/care; generated descriptions are never used as evidence. */
  async facts(context: AuthContext | undefined, productId: string, input: unknown): Promise<CatalogSource> {
    const body = asJsonObject(input), fields = asJsonObject(body.fields);
    if (Object.keys(body).some(k => !["fields", "expectedVersion"].includes(k)) || Object.keys(fields).some(k => !["material", "features", "styling", "care", "tags"].includes(k)) || Object.values(fields).some(v => !Array.isArray(v) || v.length > 20 || v.some(x => typeof x !== "string" || !x.trim() || x.length > 400 || /[<>\u0000-\u001f]/u.test(x))) || JSON.stringify(fields).length > 12000) throw new HttpError(422, "FACTS_INVALID", "Verified facts must be bounded plain text lists");
    return this.repository.execute(actor(context), "facts", { productId: id(productId), expectedVersion: version(body.expectedVersion), fields });
  }
  /** Starts two bounded workers, including restart recovery; the parent stops the service during shutdown. */
  start(): void {
    if (this.timer) return;
    this.closed = false;
    this.timer = setInterval(() => this.kick(), 2000);
    this.timer.unref();
    this.kick();
  }
  /** Stops claiming new work; active leases still have finite database deadlines. */
  stop(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
  private kick(): void {
    if (this.closed) return;
    while (this.workers.size < 2) {
      const worker = this.workOne()
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("catalog_content_operation")) {
            console.warn("[CATALOG_CONTENT_WORKER_PAUSED] Function catalog_content_operation not found; pausing background worker.");
            this.stop();
          }
        })
        .finally(() => this.workers.delete(worker));
      this.workers.add(worker);
    }
  }
  /** Executes one lease; invalid/provider output records failure and cannot alter either draft history or live product. */
  async workOne(): Promise<void> {
    const work = await this.repository.execute<CatalogWork | null>(null, "claim");
    if (!work) return;
    try {
      const prompt = catalogPrompt(work.source);
      if (prompt.length > 29000) throw new HttpError(422, "SOURCE_TOO_LARGE", "Verified context exceeds model limits");
      const raw = await this.generate(prompt, { model: this.model, temperature: 0, maxOutputTokens: 6000, timeoutMs: 45000 });
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new HttpError(422, "CONTENT_INVALID", "Model returned invalid JSON"); }
      const generated = validateCatalogContent(value, work.source);
      await this.repository.execute(work.actor_id, "finish", { id: work.id, lease: work.lease, generated, metadata: { model: this.model, schema: CATALOG_SCHEMA, prompt: CATALOG_PROMPT, sourceRevision: work.source.revision } });
    } catch (error: unknown) {
      const code = error instanceof HttpError ? error.code : "GENERATION_FAILED";
      await this.repository.execute(work.actor_id, "fail", { id: work.id, lease: work.lease, error: code });
    }
  }
}
