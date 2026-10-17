import { resolve } from "node:path";
import { selectOne, selectRows } from "../supabase.js";
import { asJsonObject, type JsonObject } from "../types.js";
import { guestStyleProfiles } from "../user/quiz.js";
import { LocalImageVectorRepository } from "../ai/image-vector-repository.js";
import { dominantCategory, dominantTone, type SearchFilters, type VisualCandidate } from "./visual-search-types.js";

/** Retrieval/profile boundary keeps provider orchestration independent of the database. */
export interface VisualSearchRepository {
  profile(owner: string, memberUserId?: string): Promise<JsonObject | null>;
  /** Nearest catalog photos for one CLIP vector, hydrated with live rows, ready to rank. */
  imageSearch(vector: number[], filters: SearchFilters): Promise<{ neighbors: VisualCandidate[]; featured: VisualCandidate[]; catalog_version: string }>;
}
/** Compare two catalog strings the same way the quiz profile stores them. */
const normalized = (value: unknown) => typeof value === "string" ? value.toLowerCase().replace(/_/g, " ") : "";
const values = (value: unknown): string[] => (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []).map(normalized);
/** Live catalog filters that a CLIP vector alone cannot answer. */
function matchesFilters(row: VisualCandidate, filters: SearchFilters): boolean {
  const price = Number(row.sale_price ?? row.base_price ?? 0);
  if (filters.min_price !== undefined && price < filters.min_price) return false;
  if (filters.max_price !== undefined && price > filters.max_price) return false;
  if (filters.body_shape && !values(row.suitable_body_shapes).includes(normalized(filters.body_shape))) return false;
  return true;
}
/** Embeddings live in the private AI index; product facts always come from the live catalog. */
export class ShopVisualSearchRepository implements VisualSearchRepository {
  private readonly vectors = new LocalImageVectorRepository(resolve(process.env.AI_PRIVATE_ROOT || "scratch/ai-private"));
  /** Only completed member quizzes or explicitly accepted same-session guest quizzes personalize retrieval. */
  async profile(owner: string, memberUserId?: string): Promise<JsonObject | null> {
    if (memberUserId) {
      const profile = await selectOne("style_profile", { user_id: `eq.${memberUserId}` });
      return profile?.quiz_completed_at ? profile : null;
    }
    return guestStyleProfiles.get(owner.replace(/^guest:/, "")) || null;
  }
  /** CLIP ranks first, then the catalog drops rows the current filters or availability exclude. */
  async imageSearch(vector: number[], filters: SearchFilters) {
    const [candidates, catalog_version] = await Promise.all([
      this.vectors.search(vector, {
        ...(filters.product_ids ? { product_ids: filters.product_ids } : {}),
        ...(filters.category_id ? { category_id: filters.category_id } : {}),
      }),
      this.vectors.version(),
    ]);
    const neighbors = await this.hydrate(candidates, filters);
    return { neighbors, featured: await this.categoryFallback(dominantCategory(neighbors) || "", dominantTone(neighbors)), catalog_version };
  }
  /** Hydration keeps CLIP order, so score ties never reorder the neighbour vote. */
  private async hydrate(candidates: Array<{ product_id: string; score: number }>, filters: SearchFilters): Promise<VisualCandidate[]> {
    if (!candidates.length) return [];
    const ids = candidates.map(candidate => candidate.product_id).join(",");
    const wantsVariants = Boolean(filters.color || filters.size);
    const [products, variants] = await Promise.all([
      selectRows("product", {
        product_id: `in.(${ids})`,
        status: "eq.on_sale",
        select: "product_id,name,slug,images,base_price,sale_price,status,is_combo,color_tone,style_tags,occasions,suitable_body_shapes,category(slug)",
        limit: "100",
      }, { count: "none", silentError: true }),
      wantsVariants
        ? selectRows("variant", { product_id: `in.(${ids})`, select: "product_id,color,size,stock_quantity,reserved_quantity" }, { count: "none", silentError: true })
        : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
    ]);
    const stock = new Map<string, { colors: string[]; sizes: string[] }>();
    for (const variant of variants.rows) {
      const entry = stock.get(String(variant.product_id)) || { colors: [], sizes: [] };
      if (typeof variant.color === "string") entry.colors.push(normalized(variant.color));
      if (typeof variant.size === "string" && Number(variant.stock_quantity || 0) > Number(variant.reserved_quantity || 0)) entry.sizes.push(normalized(variant.size));
      stock.set(String(variant.product_id), entry);
    }
    const rows = new Map(products.rows.map(row => [String(row.product_id), row]));
    return candidates.flatMap(candidate => {
      const row = rows.get(candidate.product_id);
      if (!row) return [];
      const category = row.category ? asJsonObject(row.category) : null;
      const built: VisualCandidate = {
        product_id: candidate.product_id,
        similarity: candidate.score,
        name: String(row.name || ""),
        slug: String(row.slug || ""),
        images: Array.isArray(row.images) ? row.images as string[] : [],
        base_price: Number(row.base_price || 0),
        sale_price: row.sale_price !== null && row.sale_price !== undefined ? Number(row.sale_price) : null,
        status: String(row.status || ""),
        color_tone: typeof row.color_tone === "string" ? row.color_tone : undefined,
        style_tags: Array.isArray(row.style_tags) ? row.style_tags as string[] : [],
        occasions: Array.isArray(row.occasions) ? row.occasions as string[] : [],
        suitable_body_shapes: Array.isArray(row.suitable_body_shapes) ? row.suitable_body_shapes as string[] : [],
        category_slug: category?.slug ? String(category.slug) : undefined,
        is_combo: Boolean(row.is_combo),
      };
      if (!matchesFilters(built, filters)) return [];
      const variantsForProduct = stock.get(candidate.product_id);
      if (filters.color && !values(built.color_tone).includes(normalized(filters.color)) && !variantsForProduct?.colors.includes(normalized(filters.color))) return [];
      if (filters.size && !variantsForProduct?.sizes.includes(normalized(filters.size))) return [];
      return [built];
    });
  }
  /**
   * Highest-signal on-sale rows of a category, narrowed by the voted colour
   * tone; empty slug falls back to featured products. The tone is a soft
   * signal — fewer than four rows means the vote was unreliable, so the
   * filter is dropped rather than showing the customer an empty rail.
   */
  private async categoryFallback(categorySlug: string, colorTone?: string | null): Promise<VisualCandidate[]> {
    if (categorySlug === "set-do" || categorySlug === "combo") {
      const { rows: comboRows } = await selectRows("product", {
        status: "eq.on_sale",
        is_combo: "eq.true",
        order: "is_featured.desc,updated_at.desc",
        limit: "8",
      }, { count: "none", silentError: true });
      if (comboRows.length) return comboRows.map(row => this.toCandidate(row, "set-do"));
    }
    const category = categorySlug ? await selectOne("category", { slug: `eq.${categorySlug}` }) : null;
    const base: Record<string, unknown> = {
      status: "eq.on_sale",
      order: "is_featured.desc,updated_at.desc",
      limit: "8",
    };
    if (category?.category_id) base.category_id = `eq.${category.category_id}`;
    let rows: JsonObject[] = [];
    if (colorTone) {
      const toned = await selectRows("product", { ...base, color_tone: `eq.${colorTone}` }, { count: "exact", silentError: true });
      rows = toned.rows;
      if ((toned.count ?? rows.length) < 4) rows = [];
    }
    if (!rows.length) {
      const { rows: relaxed } = await selectRows("product", base, { count: "none", silentError: true });
      rows = relaxed;
    }
    return rows.map(row => this.toCandidate(row, categorySlug));
  }
  private toCandidate(row: JsonObject, categorySlug: string): VisualCandidate {
    return {
      product_id: String(row.product_id),
      similarity: 0,
      name: String(row.name || ""),
      slug: String(row.slug || ""),
      images: Array.isArray(row.images) ? row.images as string[] : [],
      base_price: Number(row.base_price || 0),
      sale_price: row.sale_price !== null && row.sale_price !== undefined ? Number(row.sale_price) : null,
      status: "on_sale",
      category_slug: categorySlug || undefined,
      is_combo: Boolean(row.is_combo),
    };
  }
}
