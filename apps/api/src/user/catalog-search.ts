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
    .replace(/[^a-z0-9_\s]/g, " ")
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

const COMPOUND_PHRASE_MAPPINGS: Array<[RegExp, string]> = [
  [/(?<![\p{L}\p{N}])(?:tay\s+dài|dài\s+tay|tay\s+dai|dai\s+tay)(?![\p{L}\p{N}])/gui, "tay_dai"],
  [/(?<![\p{L}\p{N}])(?:tay\s+ngắn|ngắn\s+tay|cộc\s+tay|tay\s+ngan|ngan\s+tay|coc\s+tay)(?![\p{L}\p{N}])/gui, "tay_ngan"],
  [/(?<![\p{L}\p{N}])(?:không\s+tay|sát\s+nách|khong\s+tay|sat\s+nach)(?![\p{L}\p{N}])/gui, "khong_tay"],
  [/(?<![\p{L}\p{N}])(?:tay\s+lửng|lửng\s+tay|tay\s+lung|lung\s+tay)(?![\p{L}\p{N}])/gui, "tay_lung"],
  [/(?<![\p{L}\p{N}])(?:tay\s+bồng|bồng\s+tay|tay\s+bong|bong\s+tay)(?![\p{L}\p{N}])/gui, "tay_bong"],
  [/(?<![\p{L}\p{N}])(?:dáng\s+dài|dang\s+dai)(?![\p{L}\p{N}])/gui, "dang_dai"],
  [/(?<![\p{L}\p{N}])(?:dáng\s+ngắn|dang\s+ngan)(?![\p{L}\p{N}])/gui, "dang_ngan"],
  [/(?<![\p{L}\p{N}])(?:chân\s+váy|chan\s+vay)(?![\p{L}\p{N}])/gui, "chan_vay"],
  [/(?<![\p{L}\p{N}])(?:đầm|đam|dam|váy|vay)(?![\p{L}\p{N}])/gui, "dam_vay"],
  [/(?<![\p{L}\p{N}])(?:độ\s+dài|do\s+dai)(?![\p{L}\p{N}])/gui, "do_dai"],
  [/(?<![\p{L}\p{N}])(?:dự\s+tiệc|du\s+tiec|dạ\s+tiệc|da\s+tiec|dạ\s+hội|da\s+hoi)(?![\p{L}\p{N}])/gui, "du_tiec"],
  [/(?<![\p{L}\p{N}])(?:công\s+sở|cong\s+so|đi\s+làm|di\s+lam)(?![\p{L}\p{N}])/gui, "cong_so"],
];

const OCCASION_VIETNAMESE_MAP: Readonly<Record<string, string>> = {
  Party: "dự tiệc dạ tiệc dạ hội tiệc party",
  Casual: "dạo phố thường ngày đi chơi casual",
  Office: "công sở đi làm văn phòng office",
  Wedding: "đám cưới tiệc cưới wedding",
  Travel: "du lịch đi biển dạo biển nghỉ dưỡng travel",
  School: "đi học học sinh sinh viên school",
};

export function bindCompoundPhrases(text: string): string {
  let result = text;
  for (const [regex, replacement] of COMPOUND_PHRASE_MAPPINGS) {
    result = result.replace(regex, replacement);
  }
  return result;
}

/**
 * True when the text contains the whole raw phrase, or every normalized word of the phrase.
 * Preserves compound phrases and verifies attribute boundaries (sleeve, color).
 */
export function textMatchesAllWords(rawText: string, phrase: string): boolean {
  const rawPhrase = phrase.trim().toLowerCase();
  if (!rawPhrase) return true;
  if (rawText.toLowerCase().includes(rawPhrase)) return true;

  const rawTextLower = rawText.toLowerCase();
  const rawPhraseLower = rawPhrase.toLowerCase();

  // 1. Sleeve attribute conflict guard
  const queryWantsLong = /(?<![\p{L}\p{N}])(?:tay dài|dài tay|tay dai|dai tay)(?![\p{L}\p{N}])/ui.test(rawPhraseLower);
  const targetShortOnly = /(?<![\p{L}\p{N}])(?:tay ngắn|ngắn tay|cộc tay|tay ngan|ngan tay|coc tay)(?![\p{L}\p{N}])/ui.test(rawTextLower) &&
    !/(?<![\p{L}\p{N}])(?:tay dài|dài tay|tay dai|dai tay)(?![\p{L}\p{N}])/ui.test(rawTextLower);
  if (queryWantsLong && targetShortOnly) return false;

  const queryWantsShort = /(?<![\p{L}\p{N}])(?:tay ngắn|ngắn tay|cộc tay|tay ngan|ngan tay|coc tay)(?![\p{L}\p{N}])/ui.test(rawPhraseLower);
  const targetLongOnly = /(?<![\p{L}\p{N}])(?:tay dài|dài tay|tay dai|dai tay)(?![\p{L}\p{N}])/ui.test(rawTextLower) &&
    !/(?<![\p{L}\p{N}])(?:tay ngắn|ngắn tay|cộc tay|tay ngan|ngan tay|coc tay)(?![\p{L}\p{N}])/ui.test(rawTextLower);
  if (queryWantsShort && targetLongOnly) return false;

  // 2. Color attribute check for "đỏ"
  const queryHasExplicitRed = /(?<!\p{L})đỏ(?!\p{L})/iu.test(rawPhraseLower);
  if (queryHasExplicitRed) {
    const targetHasExplicitRed = /(?<!\p{L})đỏ(?!\p{L})/iu.test(rawTextLower);
    if (!targetHasExplicitRed) return false;
  }

  // 3. Compound-bound token matching
  const boundPhrase = bindCompoundPhrases(phrase);
  const boundText = bindCompoundPhrases(rawText);

  const words = normalizeCatalogText(boundPhrase).split(" ").filter(Boolean);
  if (!words.length) return false;
  const normalizedText = normalizeCatalogText(boundText);
  const textTokens = new Set(normalizedText.split(/\s+/).filter(Boolean));
  return words.every((word) => textTokens.has(word));
}
function joinText(parts: unknown[]): string {
  return parts
    .flatMap((part) => (Array.isArray(part) ? part : [part]))
    .filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    .join(" ");
}

const GARMENT_CATEGORY_TERMS: Record<string, string[]> = {
  "dam-vay": [
    "vay", "dam", "chan vay", "dam da hoi", "dam tiec", "dam du tiec",
    "vay du tiec", "vay da hoi", "dam da tiec", "vay da tiec", "vay tiec"
  ],
  "ao": ["ao", "ao so mi", "ao thun", "ao kieu", "ao len", "ao croptop", "croptop", "blouse"],
  "quan": ["quan", "quan jean", "quan jeans", "quan tay", "quan short", "quan ong rong"],
  "ao-khoac": ["ao khoac", "blazer", "vest", "hoodie", "cardigan"],
  "set-do": ["set do", "bo do"],
  "giay-dep": ["giay", "dep", "giay cao got", "giay the thao", "sandal", "sandals"],
  "phu-kien": ["phu kien", "tui", "tui xach", "khan", "that lung", "non", "mu", "kinh", "vong tay"]
};

export function queryGarmentCategory(query: string): string | null {
  const norm = normalizeCatalogText(query);
  if (!norm) return null;
  for (const [slug, terms] of Object.entries(GARMENT_CATEGORY_TERMS)) {
    if (terms.some(term => norm === term || norm.startsWith(term + " ") || norm.endsWith(" " + term))) {
      return slug;
    }
  }
  return null;
}

/** Primary product fields: title, category, brand, collection, SEO title and style tags. */
function primarySearchableText(product: JsonObject): string {
  return joinText([
    product.name,
    product.sku,
    product.category_name,
    product.category_slug,
    product.brand,
    product.collection,
    product.seo_title,
    product.style_tags,
    product.occasions,
    Array.isArray(product.occasions)
      ? product.occasions.map((o) => OCCASION_VIETNAMESE_MAP[String(o)] || String(o))
      : (typeof product.occasions === "string" ? OCCASION_VIETNAMESE_MAP[product.occasions] || product.occasions : "")
  ]);
}

/** Text searched by `q`: everything a shopper can see on a card or in the description. */
function searchableText(product: JsonObject): string {
  return joinText([
    primarySearchableText(product),
    product.seo_description,
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
  const targetCategorySlug = filters.query ? queryGarmentCategory(filters.query) : null;
  return items.filter((product) => {
    if (filters.category && !matchesCategory(product, filters.category)) return false;
    if (filters.material && !textMatchesAllWords(materialText(product), filters.material)) return false;
    if (filters.query) {
      const primaryMatch = textMatchesAllWords(primarySearchableText(product), filters.query);
      if (primaryMatch) return true;
      if (targetCategorySlug) {
        const prodSlug = normalizeCatalogText(product.category_slug || product.category_name);
        const isSameCategory = prodSlug === targetCategorySlug || prodSlug.includes(targetCategorySlug);
        if (!isSameCategory) return false;
      }
      if (!textMatchesAllWords(searchableText(product), filters.query)) return false;
    }
    return true;
  });
}
