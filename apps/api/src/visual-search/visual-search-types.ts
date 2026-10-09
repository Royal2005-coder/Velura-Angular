import { HttpError } from "../http.js";

/**
 * Category detected from the image itself plus optional semantic tags.
 * `category` is a live catalog slug (for example `dam-vay`); unknown values stay null.
 */
export interface GarmentAttributes {
  category: string | null;
  color: string | null;
  fit: string | null;
  material: string | null;
  style: string | null;
}
/** Explicit retrieval constraints, evaluated before similarity ranking. */
export interface SearchFilters {
  product_ids?: string[];
  category_id?: string;
  min_price?: number;
  max_price?: number;
  color?: string;
  size?: string;
  body_shape?: string;
}
/** Catalog candidate exposes CLIP cosine similarity separately from personalized rank. */
export interface VisualCandidate {
  product_id: string;
  similarity: number;
  rank_score?: number;
  name?: string;
  slug?: string;
  images?: string[];
  base_price?: number;
  sale_price?: number | null;
  style_tags?: string[];
  color_tone?: string;
  occasions?: string[];
  suitable_body_shapes?: string[];
  status?: string;
  category_slug?: string;
}
/** Search state carries attributes only; a source image never outlives one request. */
export interface VisualSearchResult {
  attributes: GarmentAttributes;
  matches: VisualCandidate[];
  featured: VisualCandidate[];
  catalog_version: string;
  personalized: boolean;
}
/** Validate refinements and catalog IDs before they reach SQL or provider prompts. */
export function validateFilters(raw: unknown): SearchFilters {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).some(key => !["product_ids", "category_id", "min_price", "max_price", "color", "size", "body_shape"].includes(key))) throw invalid();
  const result: SearchFilters = {};
  for (const key of ["category_id", "color", "size", "body_shape"] as const) {
    if (row[key] === undefined || row[key] === "") continue;
    if (typeof row[key] !== "string" || row[key].length > 80) throw invalid();
    result[key] = row[key].trim();
  }
  if (result.category_id && !uuid(result.category_id)) throw invalid();
  if (row.product_ids !== undefined) {
    if (!Array.isArray(row.product_ids) || row.product_ids.length > 5000 || row.product_ids.some(id => typeof id !== "string" || !uuid(id))) throw invalid();
    result.product_ids = row.product_ids as string[];
  }
  for (const key of ["min_price", "max_price"] as const) {
    if (row[key] === undefined) continue;
    if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0) throw invalid();
    result[key] = row[key];
  }
  if (result.min_price !== undefined && result.max_price !== undefined && result.min_price > result.max_price) throw invalid();
  return result;
}
/**
 * Nearest-neighbor vote for the category a photo belongs to.
 * Only the closest rows vote so a mixed photo cannot average unrelated catalog sections;
 * ties prefer the category of the single closest neighbor.
 */
export function dominantCategory(neighbors: VisualCandidate[], take = 12): string | null {
  const counts = new Map<string, number>(), closest = new Map<string, number>();
  for (const row of neighbors.slice(0, take)) {
    const slug = row.category_slug;
    if (!slug) continue;
    counts.set(slug, (counts.get(slug) || 0) + 1);
    if (!closest.has(slug)) closest.set(slug, row.similarity);
  }
  let best: string | null = null;
  for (const [slug, count] of counts) {
    if (best === null || count > counts.get(best)!) best = slug;
    else if (count === counts.get(best) && closest.get(slug)! > closest.get(best)!) best = slug;
  }
  return best;
}
/** UUID syntax shared by cancellation and catalog filters. */
export function uuid(value: string): boolean { return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value); }
function invalid(): HttpError { return new HttpError(422, "VISUAL_SEARCH_INVALID", "Thông tin tìm kiếm chưa hợp lệ."); }
