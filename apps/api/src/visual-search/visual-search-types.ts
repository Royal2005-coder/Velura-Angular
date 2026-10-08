import { HttpError } from "../http.js";

/** Exactly one visible garment is described; unknown attributes remain null, never guessed. */
export interface GarmentAttributes {
  category: string | null;
  color: string | null;
  fit: string | null;
  material: string | null;
  style: string | null;
}
/** Explicit retrieval constraints, separate from editable semantic attributes. */
export interface SearchFilters {
  product_ids?: string[];
  category_id?: string;
  min_price?: number;
  max_price?: number;
  color?: string;
  size?: string;
  body_shape?: string;
}
/** Catalog candidate exposes cosine similarity separately from personalized rank. */
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
}
/** Source-free search state is owner-bound and expires; featured rows are not matches. */
export interface VisualSearchResult {
  refinement_token: string;
  attributes: GarmentAttributes;
  keywords: string;
  matches: VisualCandidate[];
  featured: VisualCandidate[];
  catalog_version: string;
  personalized: boolean;
}
const keys = ["category", "color", "fit", "material", "style"] as const;
/** Validate provider/user structured attributes without accepting arbitrary nested output. */
export function validateAttributes(raw: unknown): GarmentAttributes {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key as typeof keys[number]))) throw invalid();
  const result: GarmentAttributes = { category: null, color: null, fit: null, material: null, style: null };
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > 80 || /[\x00-\x1f]/.test(value)) throw invalid();
    result[key] = value.trim() || null;
  }
  return result;
}
/** Reject non-clothing and ambiguous multiple garments before any embedding or catalog operation. */
export function validateExtraction(raw: unknown): GarmentAttributes {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const row = raw as Record<string, unknown>;
  if (row.is_clothing !== true || row.garment_count !== 1)
    throw new HttpError(422, "ONE_GARMENT_REQUIRED", "Chọn vùng ảnh có đúng một trang phục rõ ràng.");
  if (Object.keys(row).some(key => !["is_clothing", "garment_count", "attributes"].includes(key))) throw invalid();
  const attributes = validateAttributes(row.attributes);
  if (!attributes.category) throw invalid();
  return attributes;
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
/** Only short plain-text refinements enter the embedding request. */
export function validateKeywords(raw: unknown): string {
  if (raw === undefined) return "";
  if (typeof raw !== "string" || raw.length > 300 || /[\x00-\x1f]/.test(raw)) throw invalid();
  return raw.trim();
}
/** Canonical source-free garment description uses the existing catalog text vector space. */
export function describeGarment(attributes: GarmentAttributes, keywords: string): string {
  return `task: search result | query: ${keys.flatMap(key => attributes[key] ? [`${key}: ${attributes[key]}`] : []).concat(keywords ? [`keywords: ${keywords}`] : []).join("; ")}`;
}
/** UUID syntax shared by cancellation and catalog filters. */
export function uuid(value: string): boolean { return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value); }
function invalid(): HttpError { return new HttpError(422, "VISUAL_SEARCH_INVALID", "Thông tin tìm kiếm chưa hợp lệ."); }
