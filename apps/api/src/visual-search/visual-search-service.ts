import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { HttpError } from "../http.js";
import type { JsonObject } from "../types.js";
import type { VisualSearchRepository } from "./visual-search-repository.js";
import { dominantCategory, validateFilters, type GarmentAttributes, type SearchFilters, type VisualCandidate, type VisualSearchResult } from "./visual-search-types.js";

const MAX_BYTES = 5 * 1024 * 1024;
const CLIP_DIMENSIONS = 512;
const WORKER_VERSION = "velura-worker-v1";
const MODEL = "openclip-vit-b32-laion2b";
/** Calibrated on the live catalog: identical photo 1.00, other view of the same product 0.74–0.89, unrelated photo ≤0.48. */
const MATCH_THRESHOLD = 0.6;
const MIN_SIMILARITY = 0.5;
/** Provider adapters accept one total operation deadline and no hidden retries. */
export interface VisualProviders {
  /** Encode one decoded photo with the private GPU CLIP worker into a 512-dim unit vector. */
  embedImage(bytes: Buffer, mime: string, signal: AbortSignal, timeoutMs: number): Promise<number[]>;
  decode(bytes: Buffer, mime: string): Promise<Buffer>;
}
/** Decode all pixels, reject malformed/mismatched images and strip metadata before external inference. */
export async function decodeSearchImage(bytes: Buffer, mime: string): Promise<Buffer> {
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new HttpError(413, "VISUAL_IMAGE_SIZE", "Ảnh phải có dung lượng không quá 5 MB.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new HttpError(415, "VISUAL_IMAGE_TYPE", "Chỉ nhận JPG, PNG hoặc WEBP.");
  try {
    const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: 20_000_000, animated: false });
    const meta = await decoder.metadata();
    const expected = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" }[mime];
    if (meta.format !== expected || !meta.width || !meta.height || (meta.pages || 1) !== 1) throw new Error("INVALID_IMAGE");
    return await decoder.rotate().jpeg({ quality: 90 }).toBuffer();
  } catch { throw new HttpError(422, "VISUAL_IMAGE_UNREADABLE", "Không đọc được ảnh. Hãy chọn ảnh rõ nét khác."); }
}
/** The worker binds response bytes to this exact request, so a stale or foreign payload is never indexed. */
function workerBinding(requestId: string): { body: string; requestId: string } {
  return { requestId, body: JSON.stringify({ schema_version: WORKER_VERSION, request_id: requestId, task: "image_embedding", product_id: "", variant_id: "", image_id: "query.image" }) };
}
const providers: VisualProviders = {
  decode: decodeSearchImage,
  async embedImage(bytes, mime, signal, timeoutMs) {
    const endpoint = (process.env.AI_CLUSTER_ENDPOINT || "http://ai-worker.ai-staging.svc:8000").replace(/\/$/, "");
    const key = process.env.AI_WORKER_KEY || "";
    if (process.env.AI_DISABLE === "true" || key.length < 32) throw new HttpError(503, "VISUAL_EMBEDDER_UNAVAILABLE", "Máy tìm kiếm hình ảnh chưa sẵn sàng. Vui lòng thử lại sau.");
    const binding = workerBinding(randomUUID());
    const form = new FormData();
    form.append("binding", binding.body);
    form.append("file", new Blob([bytes], { type: mime }), "query.image");
    let payload: Record<string, unknown> | null = null;
    let status = 0;
    try {
      const response = await fetch(`${endpoint}/embed/image`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      status = response.status;
      payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok || payload?.status !== "success") throw new HttpError(502, "VISUAL_EMBED_FAILED", "Chưa phân tích được ảnh. Vui lòng thử lại.");
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof HttpError) throw error;
      throw new HttpError(status === 429 ? 429 : 503, "VISUAL_EMBEDDER_UNAVAILABLE", "Máy tìm kiếm hình ảnh chưa sẵn sàng. Vui lòng thử lại sau.");
    }
    if (!payload || payload.request_id !== binding.requestId || payload.task !== "image_embedding" || payload.model !== MODEL) throw new HttpError(502, "VISUAL_EMBED_FAILED", "Chưa phân tích được ảnh. Vui lòng thử lại.");
    const vector = payload.embedding;
    if (!Array.isArray(vector) || vector.length !== CLIP_DIMENSIONS || vector.some(value => typeof value !== "number" || !Number.isFinite(value))) throw new HttpError(502, "VISUAL_VECTOR_INVALID", "Vector tìm kiếm không hợp lệ.");
    return vector as number[];
  },
};
/** Deterministic profile rerank never lifts a sub-threshold row into semantic matches. */
export function rankVisualMatches(rows: VisualCandidate[], profile: JsonObject | null, threshold = MATCH_THRESHOLD): VisualCandidate[] {
  const normalized = (value: unknown) => typeof value === "string" ? value.toLowerCase().replace(/_/g, " ") : "";
  const values = (value: unknown): string[] => (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []).map(normalized);
  const overlap = (a: unknown, b: unknown) => values(a).some(value => values(b).includes(value));
  return rows.filter(row => Number.isFinite(row.similarity) && row.similarity >= threshold && row.status === "on_sale").map(row => {
    let bonus = 0;
    if (profile) {
      if (overlap(row.style_tags, profile.style_tags)) bonus += 0.04;
      if (overlap(row.occasions, profile.preferred_occasions)) bonus += 0.03;
      if (values(profile.favorite_colors).includes(normalized(row.color_tone))) bonus += 0.03;
      if (values(row.suitable_body_shapes).includes(normalized(profile.body_shape))) bonus += 0.04;
      const price = Number(row.sale_price ?? row.base_price ?? 0);
      const budget = String(profile.budget_range || "");
      if ((budget === "under_300k" && price < 300000) || (budget === "300k_700k" && price >= 300000 && price <= 700000) || (budget === "700k_1.5m" && price > 700000 && price <= 1500000) || (budget === "above_1.5m" && price > 1500000)) bonus += 0.03;
    }
    return { ...row, rank_score: row.similarity + bonus };
  }).sort((a, b) => b.rank_score - a.rank_score || b.similarity - a.similarity || a.product_id.localeCompare(b.product_id)).slice(0, 20);
}
/** Source images exist only during one operation; results carry attributes, never source pixels. */
export class VisualSearchService {
  private readonly requests = new Map<string, { owner: string; controller: AbortController }>();
  private readonly rates = new Map<string, { count: number; expires: number }>();
  private readonly cancelled = new Map<string, number>();
  private readonly threshold: number;
  private readonly minSimilarity: number;
  constructor(private readonly repo: VisualSearchRepository, private readonly provider: VisualProviders = providers,
    private readonly timeoutMs = Math.min(15000, Math.max(100, Number(process.env.VISUAL_SEARCH_TOTAL_TIMEOUT_MS || 15000)))) {
    this.threshold = Number(process.env.VISUAL_SEARCH_THRESHOLD) || MATCH_THRESHOLD;
    this.minSimilarity = Math.min(Number(process.env.VISUAL_SEARCH_MIN_SIMILARITY) || MIN_SIMILARITY, this.threshold);
  }
  /** Limit all searches per session, including unsuccessful submissions. */
  consume(owner: string): void {
    const now = Date.now();
    for (const [key, value] of this.rates) if (value.expires <= now) this.rates.delete(key);
    const rate = this.rates.get(owner);
    if ((rate && rate.count >= 15) || (!rate && this.rates.size >= 10000)) throw new HttpError(429, "VISUAL_SEARCH_RATE_LIMIT", "Bạn đã tìm nhiều lần. Vui lòng thử lại sau một phút.");
    this.rates.set(owner, rate ? { ...rate, count: rate.count + 1 } : { count: 1, expires: now + 60000 });
  }
  /** Cancel only this principal's in-flight request; a foreign ID never reveals its owner. */
  cancel(owner: string, requestId: string): void {
    for (const [key, expires] of this.cancelled) if (expires <= Date.now()) this.cancelled.delete(key);
    if (this.cancelled.size >= 10000) this.cancelled.delete(this.cancelled.keys().next().value!);
    this.cancelled.set(`${owner}:${requestId}`, Date.now() + 60000);
    const request = this.requests.get(requestId);
    if (request?.owner === owner) request.controller.abort(new HttpError(409, "VISUAL_SEARCH_CANCELLED", "Đã hủy tìm kiếm."));
  }
  /**
   * Photo → CLIP vector → nearest catalog photos. Rows that clear the threshold are matches;
   * below it the same neighbours only vote for a category so the catalog still answers.
   * Source bytes are destroyed on every terminal path.
   */
  async search(owner: string, requestId: string, bytes: Buffer, mime: string, rawFilters: unknown, memberUserId?: string): Promise<VisualSearchResult> {
    let decoded: Buffer | undefined;
    try {
      return await this.operation(owner, requestId, async (signal, retry) => {
        const filters = validateFilters(rawFilters);
        decoded = await this.provider.decode(bytes, mime);
        const vector = await retry(remaining => this.provider.embedImage(decoded!, "image/jpeg", signal, remaining)) as number[];
        if (vector.length !== CLIP_DIMENSIONS || vector.some(value => !Number.isFinite(value)) || !vector.some(value => value !== 0)) throw new HttpError(502, "VISUAL_VECTOR_INVALID", "Vector tìm kiếm không hợp lệ.");
        return await this.retrieve(owner, vector, filters, memberUserId, signal);
      });
    } finally { bytes.fill(0); decoded?.fill(0); }
  }
  private async retrieve(owner: string, vector: number[], filters: SearchFilters, memberUserId: string | undefined, signal: AbortSignal): Promise<VisualSearchResult> {
    const profile = await this.repo.profile(owner, memberUserId);
    if (filters.body_shape && !memberUserId) throw new HttpError(401, "BODY_FILTER_MEMBER_REQUIRED", "Đăng nhập để lọc theo dáng người.");
    if (filters.body_shape && !profile) throw new HttpError(409, "BODY_FILTER_QUIZ_REQUIRED", "Hoàn thành hồ sơ phong cách trước khi lọc dáng người.");
    if (signal.aborted) throw signal.reason;
    const catalog = await this.repo.imageSearch(vector, filters);
    if (signal.aborted) throw signal.reason;
    const best = catalog.neighbors.reduce((highest, row) => Math.max(highest, row.similarity), -Infinity);
    if (catalog.neighbors.length && best < this.minSimilarity) throw new HttpError(422, "NOT_A_GARMENT", "Không tìm thấy trang phục nào trong ảnh. Chọn ảnh có trang phục rõ ràng hơn.");
    const matches = rankVisualMatches(catalog.neighbors, profile, this.threshold);
    const attributes: GarmentAttributes = { category: dominantCategory(catalog.neighbors), color: null, fit: null, material: null, style: null };
    return { attributes, matches, featured: matches.length ? [] : catalog.featured, catalog_version: catalog.catalog_version, personalized: !!profile };
  }
  private async operation<T>(owner: string, requestId: string, run: (signal: AbortSignal, retry: (call: (remaining: number) => Promise<unknown>) => Promise<unknown>) => Promise<T>): Promise<T> {
    if ((this.cancelled.get(`${owner}:${requestId}`) || 0) > Date.now()) throw new HttpError(409, "VISUAL_SEARCH_CANCELLED", "Đã hủy tìm kiếm.");
    if (this.requests.has(requestId)) throw new HttpError(409, "VISUAL_REQUEST_RUNNING", "Yêu cầu đang được xử lý.");
    const controller = new AbortController(), deadline = Date.now() + this.timeoutMs;
    this.requests.set(requestId, { owner, controller });
    let retries = 0;
    const retry = async (call: (remaining: number) => Promise<unknown>): Promise<unknown> => {
      while (true) {
        if (controller.signal.aborted) throw controller.signal.reason;
        try { return await call(Math.max(1, deadline - Date.now())); }
        catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (!(error instanceof HttpError) || ![429, 500, 502, 503].includes(error.status) || retries >= 2) throw error;
          retries++;
        }
      }
    };
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
    const timer = setTimeout(() => controller.abort(new HttpError(504, "VISUAL_SEARCH_TIMEOUT", "Tìm kiếm quá 15 giây. Vui lòng thử lại.")), this.timeoutMs);
    try { return await Promise.race([run(controller.signal, retry), aborted]); }
    finally { clearTimeout(timer); this.requests.delete(requestId); }
  }
}
