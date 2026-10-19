import type { JsonObject } from "../types.js";

/** Longest search/filter text the storefront catalog accepts; longer input is truncated, never rejected. */
const MAX_FILTER_LENGTH = 200;

/** Storefront list filters read from the query string (`q`/`search`, `category`, `material`). */
export interface CatalogFilters {
  /** Free-text search over name, SKU, category, brand, collection, SEO, tags, occasions and description. */
  query: string;
  /** Category slug or name; empty means every category. */
  category: string;
  /** Fabric text such as `Cotton`; matched against the `Chất liệu: X` line admin appends to the description. */
  material: string;
}

/**
 * Lower-case, strip Vietnamese diacritics and every non-alphanumeric character, so that
 * `Đầm Lụa`, `dam lua` and a typed `100%` all compare on the same footing.
 */
export function normalizeCatalogText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Read one trimmed, length-capped query parameter; `search` is the legacy alias of `q`. */
function readParam(params: URLSearchParams, ...names: string[]): string {
  for (const name of names) {
    const value = params.get(name);
    if (value && value.trim()) return value.trim().slice(0, MAX_FILTER_LENGTH);
  }
  return "";
}

/** Parse storefront catalog filters from the request query string. */
export function parseCatalogFilters(params: URLSearchParams): CatalogFilters {
  return {
    query: readParam(params, "q", "search"),
    category: readParam(params, "category"),
    material: readParam(params, "material")
  };
}

/**
 * True when the text contains the whole raw phrase, or every normalized word of the phrase.
 * The match is in-process string comparison, so `%`, `*`, `,` and `)` have no special meaning
 * and can never alter a database filter. Every word must be present: a renamed product is not
 * found by a word that only its previous name contained.
 */
export function textMatchesAllWords(rawText: string, phrase: string): boolean {
  const rawPhrase = phrase.trim().toLowerCase();
  if (!rawPhrase) return true;
  if (rawText.toLowerCase().includes(rawPhrase)) return true;
  const words = normalizeCatalogText(phrase).split(" ").filter(Boolean);
  if (!words.length) return false;
  const normalizedText = normalizeCatalogText(rawText);
  return words.every((word) => normalizedText.includes(word));
}

function joinText(parts: unknown[]): string {
  return parts
    .flatMap((part) => (Array.isArray(part) ? part : [part]))
    .filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    .join(" ");
}

/** Text searched by `q`: everything a shopper can see on a card or in the description. */
function searchableText(product: JsonObject): string {
  return joinText([
    product.name,
    product.sku,
    product.category_name,
    product.category_slug,
    product.brand,
    product.collection,
    product.seo_title,
    product.seo_description,
    product.style_tags,
    product.occasions,
    product.description
  ]);
}

/** `Chất liệu: X` lines written into the description by the admin create form. */
function materialText(product: JsonObject): string {
  const description = typeof product.description === "string" ? product.description : "";
  const lines = description
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:chất liệu|chat lieu|material)\s*[:：]/i.test(line));
  return lines.length ? lines.join(" ") : joinText([product.name, description]);
}

function matchesCategory(product: JsonObject, category: string): boolean {
  const wanted = normalizeCatalogText(category);
  if (!wanted) return true;
  return [product.category_slug, product.category_name].some((value) => normalizeCatalogText(value) === wanted);
}

/**
 * Apply the storefront query, category and material filters to the cached catalog rows.
 * Filtering happens on a fresh copy per request, so the shared cache never keeps a stale
 * search result and a rename is visible as soon as the cache is invalidated.
 */
export function filterCatalogProducts<T extends JsonObject>(items: readonly T[], filters: CatalogFilters): T[] {
  return items.filter((product) => {
    if (filters.category && !matchesCategory(product, filters.category)) return false;
    if (filters.material && !textMatchesAllWords(materialText(product), filters.material)) return false;
    if (filters.query && !textMatchesAllWords(searchableText(product), filters.query)) return false;
    return true;
  });
}
