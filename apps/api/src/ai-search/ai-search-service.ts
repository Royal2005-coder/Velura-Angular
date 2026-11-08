import { randomUUID } from "node:crypto";
import { HttpError } from "../http.js";
import type { JsonObject } from "../types.js";
import { decodeSearchImage, rankVisualMatches, visualProviders, type DecodedImage, type VisualProviders } from "../visual-search/visual-search-service.js";
import { categoryLabel, dominantCategory, dominantTone, toneLabel, validateFilters, type SearchFilters, type VisualCandidate } from "../visual-search/visual-search-types.js";
import type { AiSearchRepository, AiSearchResult } from "./ai-search-types.js";
import { fashionQuery } from "./ai-search-text.js";

const CLIP_DIMENSIONS = 512;
const WORKER_VERSION = "velura-worker-v1";
const MODEL = "openclip-vit-b32-laion2b";
/**
 * Initial heuristic floors for zero-shot CLIP text↔image cosine: a well-matched
 * caption/photo pair sits near 0.30 on ViT-B/32 while unrelated pairs stay ≤0.20.
 * Env-overridable pending live-catalog calibration, the same contract the
 * calibrated photo thresholds use; they never admit a row by profile bonus alone.
 */
const TEXT_SIMILAR = 0.22;
const TEXT_STRONG = 0.30;
/** Composed cosine = (IS+EM)/‖r+m‖ dilutes both components, so its floors sit below the photo-only ones. */
const COMPOSED_SIMILAR = 0.42;
const COMPOSED_STRONG = 0.60;
/** Same photo-signal floor as visual search, applied to the IS component only. */
const GARMENT_FLOOR = 0.3;
/** Provider adapters accept one total operation deadline and no hidden retries. */
export interface AiSearchProviders extends VisualProviders {
  /** Encode one normalized query/modifier with the private CLIP worker into the shared 512-dim namespace. */
  embedText(text: string, signal: AbortSignal, timeoutMs: number): Promise<number[]>;
}
function assertVector(vector: number[]): void {
  if (vector.length !== CLIP_DIMENSIONS || vector.some(value => !Number.isFinite(value)) || !vector.some(value => value !== 0)) throw new HttpError(502, "AI_SEARCH_VECTOR_INVALID", "Vector tìm kiếm không hợp lệ.");
}
/** The worker binds response bytes to this exact request, so a stale or foreign payload is never ranked. */
function textBinding(requestId: string): { body: string; requestId: string } {
  return { requestId, body: JSON.stringify({ schema_version: WORKER_VERSION, request_id: requestId, task: "text_embedding", product_id: "", variant_id: "", image_id: "query.text" }) };
}
/** Text inference is CPU-only on the worker; it never queues behind a GPU try-on lease. */
export const aiSearchProviders: AiSearchProviders = {
  ...visualProviders,
  async embedText(text, signal, timeoutMs) {
    const endpoint = (process.env.AI_CLUSTER_ENDPOINT || "http://ai-worker.ai-staging.svc:8000").replace(/\/$/, "");
    const key = process.env.AI_WORKER_KEY || "";
    if (process.env.AI_DISABLE === "true" || key.length < 32) throw new HttpError(503, "AI_SEARCH_EMBEDDER_UNAVAILABLE", "Máy tìm kiếm AI chưa sẵn sàng. Vui lòng thử lại sau.");
    const binding = textBinding(randomUUID());
    const form = new FormData();
    form.append("binding", binding.body);
    form.append("text", text);
    let payload: Record<string, unknown> | null = null;
    let status = 0;
    try {
      const response = await fetch(`${endpoint}/embed/text`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      status = response.status;
      payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok || payload?.status !== "success") throw new HttpError(502, "AI_SEARCH_EMBED_FAILED", "Chưa phân tích được từ khóa. Vui lòng thử lại.");
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof HttpError) throw error;
      throw new HttpError(status === 429 ? 429 : 503, "AI_SEARCH_EMBEDDER_UNAVAILABLE", "Máy tìm kiếm AI chưa sẵn sàng. Vui lòng thử lại sau.");
    }
    if (!payload || payload.request_id !== binding.requestId || payload.task !== "text_embedding" || payload.model !== MODEL) throw new HttpError(502, "AI_SEARCH_EMBED_FAILED", "Chưa phân tích được từ khóa. Vui lòng thử lại.");
    const vector = payload.embedding;
    if (!Array.isArray(vector) || vector.length !== CLIP_DIMENSIONS || vector.some(value => typeof value !== "number" || !Number.isFinite(value))) throw new HttpError(502, "AI_SEARCH_VECTOR_INVALID", "Vector tìm kiếm không hợp lệ.");
    return vector as number[];
  },
};
/**
 * Semantic text and composed (photo + text feedback) search over the same CLIP
 * catalog index as photo search. Composition follows CLARTEMIS's EM/IS scoring
 * (arXiv:2203.08101) zero-shot: rank by normalize(reference+modifier), gate on the
 * reference photo's garment signal, and reuse the calibrated fallback machinery.
 * Query text and source images exist only during one operation; nothing is persisted.
 */
export class AiSearchService {
  private readonly requests = new Map<string, { owner: string; controller: AbortController }>();
  private readonly rates = new Map<string, { count: number; expires: number }>();
  private readonly cancelled = new Map<string, number>();
  private readonly textSimilar: number;
  private readonly textStrong: number;
  private readonly composedSimilar: number;
  private readonly composedStrong: number;
  private readonly garmentFloor: number;
  constructor(private readonly repo: AiSearchRepository, private readonly provider: AiSearchProviders = aiSearchProviders,
    private readonly timeoutMs = Math.min(15000, Math.max(100, Number(process.env.AI_SEARCH_TOTAL_TIMEOUT_MS || 15000)))) {
    this.textStrong = Number(process.env.AI_SEARCH_TEXT_THRESHOLD) || TEXT_STRONG;
    this.textSimilar = Math.min(Number(process.env.AI_SEARCH_TEXT_MIN_SIMILARITY) || TEXT_SIMILAR, this.textStrong);
    this.composedStrong = Number(process.env.AI_SEARCH_COMPOSED_THRESHOLD) || COMPOSED_STRONG;
    this.composedSimilar = Math.min(Number(process.env.AI_SEARCH_COMPOSED_MIN_SIMILARITY) || COMPOSED_SIMILAR, this.composedStrong);
    this.garmentFloor = Number(process.env.VISUAL_SEARCH_GARMENT_FLOOR) || GARMENT_FLOOR;
  }
  /** Limit all AI searches per session, including unsuccessful submissions. */
  consume(owner: string): void {
    const now = Date.now();
    for (const [key, value] of this.rates) if (value.expires <= now) this.rates.delete(key);
    const rate = this.rates.get(owner);
    if ((rate && rate.count >= 15) || (!rate && this.rates.size >= 10000)) throw new HttpError(429, "AI_SEARCH_RATE_LIMIT", "Bạn đã tìm nhiều lần. Vui lòng thử lại sau một phút.");
    this.rates.set(owner, rate ? { ...rate, count: rate.count + 1 } : { count: 1, expires: now + 60000 });
  }
  /** Cancel only this principal's in-flight request; a foreign ID never reveals its owner. */
  cancel(owner: string, requestId: string): void {
    for (const [key, expires] of this.cancelled) if (expires <= Date.now()) this.cancelled.delete(key);
    if (this.cancelled.size >= 10000) this.cancelled.delete(this.cancelled.keys().next().value!);
    this.cancelled.set(`${owner}:${requestId}`, Date.now() + 60000);
    const request = this.requests.get(requestId);
    if (request?.owner === owner) request.controller.abort(new HttpError(409, "AI_SEARCH_CANCELLED", "Đã hủy tìm kiếm."));
  }
  /** Query text → CLIP text vector → nearest catalog photos in the shared image namespace. */
  async textSearch(owner: string, requestId: string, query: string, rawFilters: unknown, memberUserId?: string): Promise<AiSearchResult> {
    return this.operation(owner, requestId, async (signal, retry) => {
      const filters = validateFilters(rawFilters);
      const text = this.queryText(query);
      await this.repo.assertReady?.();
      const vector = await retry(remaining => this.provider.embedText(text, signal, remaining)) as number[];
      assertVector(vector);
      const profile = await this.repo.profile(owner, memberUserId);
      this.assertBodyFilter(filters, profile, memberUserId);
      if (signal.aborted) throw signal.reason;
      const catalog = await this.repo.imageSearch(vector, filters);
      if (signal.aborted) throw signal.reason;
      return this.finish("text", text, catalog, profile, this.textSimilar, this.textStrong);
    });
  }
  /**
   * Photo + modifier → composed CLIP query → catalog. The garment verdict uses the
   * IS component so a strong text match cannot rescue a photo with no garment.
   * Source bytes are destroyed on every terminal path.
   */
  async composedSearch(owner: string, requestId: string, bytes: Buffer, mime: string, modifier: string, rawFilters: unknown, memberUserId?: string): Promise<AiSearchResult> {
    let decoded: DecodedImage | undefined;
    try {
      return await this.operation(owner, requestId, async (signal, retry) => {
        const filters = validateFilters(rawFilters);
        const text = this.queryText(modifier);
        await this.repo.assertReady?.();
        decoded = await this.provider.decode(bytes, mime);
        const reference = await retry(remaining => this.provider.embedImage(decoded!.bytes, decoded!.mime, signal, remaining)) as number[];
        assertVector(reference);
        const modifierVector = await retry(remaining => this.provider.embedText(text, signal, remaining)) as number[];
        assertVector(modifierVector);
        const profile = await this.repo.profile(owner, memberUserId);
        this.assertBodyFilter(filters, profile, memberUserId);
        if (signal.aborted) throw signal.reason;
        const catalog = await this.repo.composedSearch(reference, modifierVector, filters);
        if (signal.aborted) throw signal.reason;
        const bestReference = catalog.neighbors.reduce((highest, row) => Math.max(highest, row.is_score ?? row.similarity), -Infinity);
        if (catalog.neighbors.length && bestReference < this.garmentFloor) throw new HttpError(422, "NOT_A_GARMENT", "Không tìm thấy trang phục nào trong ảnh. Chọn ảnh có trang phục rõ ràng hơn.");
        return this.finish("composed", text, catalog, profile, this.composedSimilar, this.composedStrong);
      });
    } finally { bytes.fill(0); decoded?.bytes.fill(0); }
  }
  private queryText(raw: string): string {
    const text = fashionQuery(raw);
    if (!text) throw new HttpError(422, "AI_SEARCH_TEXT_INVALID", "Từ khóa chưa rõ nghĩa. Hãy mô tả trang phục, ví dụ: đầm đỏ dáng xòe.");
    return text;
  }
  private assertBodyFilter(filters: SearchFilters, profile: JsonObject | null, memberUserId?: string): void {
    if (filters.body_shape && !memberUserId) throw new HttpError(401, "BODY_FILTER_MEMBER_REQUIRED", "Đăng nhập để lọc theo dáng người.");
    if (filters.body_shape && !profile) throw new HttpError(409, "BODY_FILTER_QUIZ_REQUIRED", "Hoàn thành hồ sơ phong cách trước khi lọc dáng người.");
  }
  private finish(mode: "text" | "composed", text: string, catalog: { neighbors: VisualCandidate[]; featured: VisualCandidate[]; catalog_version: string }, profile: JsonObject | null, similar: number, strong: number): AiSearchResult {
    const matches = rankVisualMatches(catalog.neighbors, profile, similar, strong);
    const category = dominantCategory(catalog.neighbors);
    const tone = dominantTone(catalog.neighbors);
    const featured = matches.length ? [] : catalog.featured;
    return {
      mode,
      query_text: text,
      attributes: { category, color: null, fit: null, material: null, style: null },
      matches,
      featured,
      catalog_version: catalog.catalog_version,
      personalized: !!profile,
      fallback: featured.length ? { category, category_name: categoryLabel(category), color_tone: tone, color_name: toneLabel(tone) } : null,
    };
  }
  private async operation<T>(owner: string, requestId: string, run: (signal: AbortSignal, retry: (call: (remaining: number) => Promise<unknown>) => Promise<unknown>) => Promise<T>): Promise<T> {
    if ((this.cancelled.get(`${owner}:${requestId}`) || 0) > Date.now()) throw new HttpError(409, "AI_SEARCH_CANCELLED", "Đã hủy tìm kiếm.");
    if (this.requests.has(requestId)) throw new HttpError(409, "AI_SEARCH_REQUEST_RUNNING", "Yêu cầu đang được xử lý.");
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
    const timer = setTimeout(() => controller.abort(new HttpError(504, "AI_SEARCH_TIMEOUT", "Tìm kiếm quá 15 giây. Vui lòng thử lại.")), this.timeoutMs);
    try { return await Promise.race([run(controller.signal, retry), aborted]); }
    finally { clearTimeout(timer); this.requests.delete(requestId); }
  }
}