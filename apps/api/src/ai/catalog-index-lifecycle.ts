import { randomUUID } from "node:crypto";
import { HttpError } from "../http.js";
import type { AiService } from "./ai-service.js";
import type { LocalImageVectorRepository } from "./image-vector-repository.js";

type Revision = { product_id: string; image_revision: string };
/** Discovery reads published shop photos only, in stable bounded pages. */
export interface CatalogIndexSource {
  published(after: string, limit: number): Promise<Revision[]>;
}
/** One API-owned synchronizer submits catalog-only jobs to the existing serialized inference queue. */
export class CatalogIndexLifecycle {
  private timer?: ReturnType<typeof setTimeout>;
  private flight?: Promise<void>;
  private stopped = false;
  private cursor = "";
  private nextScan = 0;
  private active?: { id: string; rows: Revision[] };
  private readonly skipped = new Map<string, { revision: string; error: string }>();
  private readonly owner = "system:catalog-image-index";
  private readonly run = randomUUID();
  private sequence = 0;
  private scan = { published: 0, indexed: 0, skipped: 0 };
  private coverage?: { published: number; indexed: number; skipped: number; completed_at: string };
  private error?: string;
  constructor(
    private readonly service: Pick<AiService, "refreshReadiness" | "capabilities" | "create" | "get" | "cancel">,
    private readonly source: CatalogIndexSource,
    private readonly vectors: Pick<LocalImageVectorRepository, "revisions">,
  ) {}
  /** Last completed catalog scan, never a fabricated total or worker-ready flag. */
  status() {
    return { syncing: !!this.active, coverage: this.coverage ?? null, error: this.error ?? null };
  }
  /** Start once after queue recovery; no search request triggers synchronization. */
  start(): void {
    if (this.timer || this.stopped) return;
    const schedule = () => {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.tick().finally(() => { if (!this.stopped) schedule(); });
      }, 1000);
      this.timer.unref();
    };
    schedule();
  }
  /** One finite discovery page or terminal-job observation; overlapping callers share the same flight. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.flight) return this.flight;
    this.flight = this.synchronize().catch(error => {
      this.error = error instanceof HttpError ? error.code : "CATALOG_INDEX_SYNC_FAILED";
      this.nextScan = Date.now() + 60_000;
    }).finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async synchronize(): Promise<void> {
    if (this.active) {
      const current = await this.service.get(this.owner, this.active.id).catch(error => {
        if (!(error instanceof HttpError) || error.code !== "JOB_NOT_FOUND") throw error;
        return undefined;
      });
      if (!current) {
        this.active = undefined;
        this.error = "AI_JOB_EXPIRED";
        return;
      }
      if (["queued", "running"].includes(current.status)) return;
      const revisions = await this.vectors.revisions();
      for (const row of this.active.rows) {
        if (revisions.get(row.product_id) === row.image_revision) this.scan.indexed++;
        else {
          const error = current.index_summary?.errors.find(item => item.product_id === row.product_id)?.error || current.error || "CATALOG_IMAGE_UNAVAILABLE";
          // Infrastructure failures remain pending for the next scan, not bad-image skips.
          if (!["AI_ENGINE_UNAVAILABLE", "AI_JOB_TIMEOUT", "AI_JOB_INTERRUPTED", "AI_INFERENCE_FAILED"].includes(error)) {
            this.skipped.set(row.product_id, { revision: row.image_revision, error });
            this.scan.skipped++;
          }
        }
      }
      this.active = undefined;
      return;
    }
    if (Date.now() < this.nextScan) return;
    await this.service.refreshReadiness();
    if (this.stopped) return;
    if (!this.service.capabilities().tasks.some(row => row.task === "image_embedding" && row.enabled)) {
      this.error = "AI_ENGINE_UNAVAILABLE";
      this.nextScan = Date.now() + 15_000;
      return;
    }
    const revisions = await this.vectors.revisions();
    const page = await this.source.published(this.cursor, 16);
    if (this.stopped) return;
    if (!page.length) {
      this.coverage = { ...this.scan, completed_at: new Date().toISOString() };
      this.scan = { published: 0, indexed: 0, skipped: 0 };
      this.cursor = "";
      this.nextScan = Date.now() + 60_000;
      this.error = undefined;
      return;
    }
    const pending: Revision[] = [];
    let indexed = 0, skipped = 0;
    for (const row of page) {
      if (revisions.get(row.product_id) === row.image_revision) { indexed++; this.skipped.delete(row.product_id); }
      else if (this.skipped.get(row.product_id)?.revision === row.image_revision) skipped++;
      else pending.push(row);
    }
    if (pending.length) {
      try {
        const job = await this.service.create(this.owner, {
          task: "image_embedding", catalog_index: true,
          catalog_product_ids: pending.map(row => row.product_id),
          consent: true, confirmed: true,
          idempotency_key: `sync-${this.run}-${this.sequence++}`,
        }, true);
        this.active = { id: job.id, rows: pending };
      } catch (error) {
        if (!(error instanceof HttpError) || error.code !== "CATALOG_BATCH_EMPTY") throw error;
        for (const row of pending) this.skipped.set(row.product_id, { revision: row.image_revision, error: error.code });
        skipped += pending.length;
      }
    }
    this.scan.published += page.length;
    this.scan.indexed += indexed;
    this.scan.skipped += skipped;
    this.cursor = page[page.length - 1].product_id;
    this.error = undefined;
  }
  /** Stop scheduling before cancelling this synchronizer's sole job; never shut down a second queue. */
  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.flight;
    if (this.active) await this.service.cancel(this.owner, this.active.id).catch(() => undefined);
    this.active = undefined;
  }
}
