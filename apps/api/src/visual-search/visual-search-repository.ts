import { config } from "../config.js";
import { callRpc, selectOne, selectRows, updateRows } from "../supabase.js";
import { asJsonObject, type JsonObject } from "../types.js";
import { guestStyleProfiles } from "../user/quiz.js";
import { generateGeminiEmbedding, vectorLiteral } from "../gemini-client.js";
import { buildProductEmbeddingText } from "../recommendation-service.js";
import type { SearchFilters, VisualCandidate } from "./visual-search-types.js";

/** Retrieval/profile boundary keeps provider orchestration independent of the database. */
export interface VisualSearchRepository {
  profile(owner: string, memberUserId?: string): Promise<JsonObject | null>;
  search(vector: number[], filters: SearchFilters): Promise<{ matches: VisualCandidate[]; featured: VisualCandidate[]; catalog_version: string }>;
  categoryFallback?(category: string): Promise<VisualCandidate[]>;
}

const CATEGORY_MAP: Record<string, string> = {
  top: "ao", blouse: "ao", shirt: "ao", tshirt: "ao",
  pants: "quan", trousers: "quan", jeans: "quan",
  dress: "dam-vay", skirt: "dam-vay",
  jacket: "ao-khoac", coat: "ao-khoac", blazer: "ao-khoac",
  set: "set-do", suit: "set-do",
  accessories: "phu-kien", bag: "phu-kien", hat: "phu-kien", scarf: "phu-kien",
  shoes: "giay-dep", sandals: "giay-dep", boots: "giay-dep", sneakers: "giay-dep",
};
/** Uses the same configured text model for query and refreshed sale-catalog vectors. */
export class ShopVisualSearchRepository implements VisualSearchRepository {
  /** Only completed member quizzes or explicitly accepted same-session guest quizzes personalize retrieval. */
  async profile(owner: string, memberUserId?: string): Promise<JsonObject | null> {
    if (memberUserId) {
      const profile = await selectOne("style_profile", { user_id: `eq.${memberUserId}` });
      return profile?.quiz_completed_at ? profile : null;
    }
    return guestStyleProfiles.get(owner.replace(/^guest:/, "")) || null;
  }
  /** Live filters and model/revision checks are evaluated in one versioned SQL snapshot. */
  async search(vector: number[], filters: SearchFilters) {
    const raw = asJsonObject(await callRpc("visual_search_catalog", {
      query_embedding: vectorLiteral(vector), query_model: config.geminiEmbeddingModel,
      match_threshold: Number(process.env.VISUAL_SEARCH_THRESHOLD || 0.45), filters,
    }, { silentError: true }));
    return { matches: (raw.matches || []) as VisualCandidate[], featured: (raw.featured || []) as VisualCandidate[], catalog_version: String(raw.catalog_version) };
  }
  /** Fallback to top-rated shop products in the detected category when no vector matches meet threshold. */
  async categoryFallback(category: string): Promise<VisualCandidate[]> {
    const slug = CATEGORY_MAP[category.toLowerCase().trim()] || category.toLowerCase().trim();
    const cat = await selectOne("category", { slug: `eq.${slug}` });
    if (!cat?.category_id) return [];
    const { rows } = await selectRows("product", {
      category_id: `eq.${cat.category_id}`,
      status: "eq.on_sale",
      is_combo: "eq.false",
      order: "is_featured.desc,updated_at.desc",
      limit: "8",
    }, { count: "none", silentError: true });
    return rows.map(r => ({
      product_id: String(r.product_id),
      similarity: 0,
      name: String(r.name || ""),
      slug: String(r.slug || ""),
      images: Array.isArray(r.images) ? r.images as string[] : [],
      base_price: Number(r.base_price || 0),
      sale_price: r.sale_price !== null && r.sale_price !== undefined ? Number(r.sale_price) : null,
      status: "on_sale",
    }));
  }
}
/** Durable outbox refresh resumes after restart and replaces vectors only for the read revision. */
export class VisualCatalogRefresher {
  private running = false;
  /** Process a bounded outbox batch; one failed item cannot prevent other real catalog updates. */
  async refresh(): Promise<{ refreshed: number; failed: number }> {
    if (this.running) return { refreshed: 0, failed: 0 };
    this.running = true;
    let refreshed = 0, failed = 0;
    try {
      await callRpc("visual_catalog_enqueue_model", { p_model: config.geminiEmbeddingModel }, { silentError: true });
      const pending = await selectRows("visual_catalog_refresh", { retry_at: `lte.${new Date().toISOString()}`, order: "requested_at.asc", limit: 10 }, { count: "none", silentError: true });
      for (const job of pending.rows) {
        try {
          const entry = asJsonObject(await callRpc("visual_catalog_entry", { p_product_id: job.product_id }, { silentError: true }));
          const product = asJsonObject(entry.product);
          if (!product.product_id) continue;
          const revision = entry.revision;
          const embedding = await generateGeminiEmbedding(await buildProductEmbeddingText(product), { dimensions: 1536, maxRetries: 2, timeoutMs: 15000 });
          if (embedding.length !== 1536 || embedding.some(value => !Number.isFinite(value))) throw new Error("INVALID_CATALOG_VECTOR");
          const committed = await callRpc("visual_catalog_commit", { p_product_id: job.product_id, p_requested_at: job.requested_at, p_revision: revision, p_model: config.geminiEmbeddingModel, p_embedding: vectorLiteral(embedding) }, { silentError: true });
          if (committed === true) refreshed++;
        } catch {
          failed++;
          const attempts = Number(job.attempts || 0) + 1;
          await updateRows("visual_catalog_refresh", { product_id: `eq.${job.product_id}`, requested_at: `eq.${job.requested_at}` }, {
            attempts, error_code: "CATALOG_EMBEDDING_FAILED", retry_at: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7))).toISOString(),
          }, { silentError: true });
        }
      }
      return { refreshed, failed };
    } finally { this.running = false; }
  }
}
/** Start one API-process poller; durable rows, not this timer, own pending catalog work. */
export function startVisualCatalogRefresh(): () => void {
  const refresher = new VisualCatalogRefresher();
  const run = () => { void refresher.refresh().catch(() => console.warn("[VISUAL_CATALOG_REFRESH_UNAVAILABLE]")); };
  const timer = setInterval(run, Math.max(5000, Number(process.env.VISUAL_CATALOG_REFRESH_MS || 15000)));
  timer.unref(); run();
  return () => clearInterval(timer);
}
