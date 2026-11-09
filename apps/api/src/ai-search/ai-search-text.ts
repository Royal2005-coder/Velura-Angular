import { HttpError } from "../http.js";
import { ACCESSORY_CATEGORY_SLUGS, COLOR_FAMILIES, COLOR_FAMILY_LABELS, GARMENT_CATEGORY_SLUGS, matchesAnySynonym, type QueryAttributes } from "../visual-search/visual-search-types.js";
/** One bounded customer utterance; the worker additionally caps encoded text at 500 characters. */
export const MAX_QUERY_CHARS = 200;
/** Reject non-text, control characters and punctuation-only queries before any inference. */
export function validateSearchText(raw: unknown, kind: "query" | "modifier"): string {
  if (typeof raw !== "string" || /[\u0000-\u001f]/.test(raw)) throw invalid(kind);
  const value = raw.replace(/\s+/g, " ").trim();
  if (!value || value.length > MAX_QUERY_CHARS || !/[\p{L}\p{N}]/u.test(value)) throw invalid(kind);
  return value;
}
function invalid(kind: "query" | "modifier"): HttpError {
  return new HttpError(422, "AI_SEARCH_TEXT_INVALID", kind === "query"
    ? "Nhập từ khóa tìm kiếm từ 1 đến 200 ký tự."
    : "Nhập mô tả chỉnh sửa từ 1 đến 200 ký tự, ví dụ: màu đỏ, dáng xòe.");
}
/**
 * Deterministic Vietnamese→English fashion lexicon. CLIP's tokenizer is
 * English-centric (Radford et al. 2021), so common catalog terms are mapped
 * offline before encoding; unmapped words (brands, English input) pass through.
 * No third-party translation service ever receives the customer's query.
 */
const LEXICON: Record<string, string> = {
  "áo khoác": "jacket", "áo sơ mi": "shirt", "áo thun": "t-shirt", "áo kiểu": "blouse",
  "áo len": "sweater", "áo hoodie": "hoodie", "áo vest": "blazer", "áo crop": "crop top",
  "áo dài": "traditional vietnamese dress", "croptop": "crop top",
  "quần jean": "jeans", "quần jeans": "jeans", "quần tây": "trousers", "quần short": "shorts",
  "quần kaki": "chinos", "quần legging": "leggings", "quần ống rộng": "wide leg pants",
  "quần ống suông": "straight leg pants", "chân váy": "skirt", "đầm váy": "dress",
  "đầm dự tiệc": "party dress", "đầm công sở": "office dress", "set đồ": "matching set",
  "bộ đồ": "outfit set", "túi xách": "handbag", "giày cao gót": "high heels",
  "giày thể thao": "sneakers", "khăn choàng": "scarf", "thắt lưng": "belt",
  "áo": "top", "quần": "pants", "đầm": "dress", "váy": "dress", "giày": "shoes",
  "túi": "bag", "dép": "sandals", "nón": "hat", "mũ": "hat", "phụ kiện": "accessories",
  "xanh dương": "blue", "xanh navy": "navy", "xanh lá": "green", "xanh ngọc": "teal",
  "đen": "black", "trắng": "white", "đỏ": "red", "vàng": "yellow", "hồng": "pink",
  "tím": "purple", "nâu": "brown", "be": "beige", "kem": "cream", "xám": "gray",
  "cam": "orange", "xanh": "blue", "màu": "",
  "ôm": "fitted", "rộng": "loose", "xòe": "flared", "suông": "straight",
  "oversize": "oversized", "cạp cao": "high waisted", "lửng": "cropped", "thon": "slim",
  "ngắn": "short", "dài": "long", "midi": "midi", "maxi": "maxi",
  "lụa": "silk", "linen": "linen", "cotton": "cotton", "denim": "denim", "kaki": "khaki",
  "len": "wool", "da": "leather", "voan": "chiffon", "nhung": "velvet", "thun": "jersey",
  "công sở": "office", "đi làm": "office work", "dạo phố": "casual street",
  "đi chơi": "casual outing", "dự tiệc": "party", "đi tiệc": "party", "đi biển": "beach",
  "thể thao": "sporty", "đi học": "school", "thanh lịch": "elegant", "cá tính": "edgy",
  "dễ thương": "cute", "sang trọng": "luxury", "vintage": "vintage", "trẻ trung": "youthful",
  "năng động": "active", "nữ tính": "feminine", "giá rẻ": "affordable",
  "hoa": "floral", "kẻ sọc": "striped", "sọc": "striped", "caro": "plaid",
  "chấm bi": "polka dot", "trơn": "solid", "cổ tròn": "round neck", "cổ chữ v": "v neck",
  "cổ vuông": "square neck", "cổ lọ": "turtleneck", "tay dài": "long sleeve",
  "tay ngắn": "short sleeve", "không tay": "sleeveless", "tay phồng": "puff sleeve",
  "xếp ly": "pleated", "thắt eo": "waist tie", "hai dây": "spaghetti strap",
  "quây": "strapless", "hở vai": "off shoulder", "hở lưng": "backless",
  "tìm": "", "kiếm": "", "muốn": "", "mua": "", "cho tôi": "", "tôi muốn": "",
};
/** Longest phrases first so "áo khoác" wins over "áo"; word boundaries protect brand names. */
const ENTRIES = Object.entries(LEXICON).sort(([a], [b]) => b.length - a.length)
  .map(([phrase, replacement]) => [
    new RegExp(`(?<![\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu"),
    replacement,
  ] as const);
/** Normalize one query/modifier into the text the CLIP text encoder actually receives. */
export function fashionQuery(text: string): string {
  let value = text.toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of ENTRIES) value = value.replace(pattern, replacement);
  return value.replace(/\s+/g, " ").trim();
}

/** Query words mapped to the catalog's English style_tags vocabulary for ranking. */
const STYLE_MAP: Array<[string, string]> = [
  ["thanh lich|sang trong|elegant|luxury", "Elegant"],
  ["toi gian|minimalist", "Minimalist"],
  ["co dien|classic", "Classic"],
  ["hien dai|modern", "Modern"],
  ["lang man|romantic|nu tinh", "Romantic"],
  ["nang dong|sporty|the thao", "Sporty"],
  ["ca tinh|street|edgy", "Street"],
  ["vintage", "Vintage"],
  ["hoc duong|preppy", "Preppy"],
  ["boho", "Boho"],
  ["dao pho|casual", "Casual"],
];
/** Query words mapped to the catalog's English occasions vocabulary for ranking. */
const OCCASION_MAP: Array<[string, string]> = [
  ["di tiec|du tiec|party", "Party"],
  ["cong so|di lam|office", "Office"],
  ["di choi|dao pho|casual|di dao", "Casual"],
  ["di bien|beach|du lich|travel", "Travel"],
  ["di hoc|school", "School"],
  ["the thao|sport|gym", "Sport"],
  ["hen ho|date", "Date"],
  ["dam cuoi|wedding", "Wedding"],
  ["sinh nhat|birthday", "Birthday"],
  ["brunch", "Brunch"],
  ["cuoi tuan|weekend", "Weekend"],
  ["su kien|event", "Event"],
];

/**
 * Extract explicit fashion attributes from a query or modifier. Category is the
 * first retrieval constraint: a specific garment/accessory word narrows to its
 * catalog section, "quần áo"/"đồ" narrows to clothing only (never accessories),
 * and an occasion-only query ("đi tiệc", "đi chơi") leaves every category open.
 */
export function extractQueryAttributes(text: string): QueryAttributes {
  const norm = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d");
  const has = (pattern: string) => new RegExp(`\\b(?:${pattern})\\b`).test(norm);
  const lower = text.toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ");
  const attrs: QueryAttributes = {};

  if (has("set do|bo do|do bo|matching set")) { attrs.category = "set-do"; attrs.allowedCategories = ["set-do"]; }
  else if (has("ao khoac|blazer|vest|hoodie|cardigan|bomber|jacket|khoac")) { attrs.category = "ao-khoac"; attrs.allowedCategories = ["ao-khoac"]; }
  else if (has("dam|vay|chan vay|dress|skirt|gown")) { attrs.category = "dam-vay"; attrs.allowedCategories = ["dam-vay"]; }
  else if (has("quan ao|trang phuc|clothing|clothes|outfit")) { attrs.allowedCategories = GARMENT_CATEGORY_SLUGS; }
  else if (has("quan|jeans?|shorts?|kaki|trousers?|pants?|culottes|leggings?")) { attrs.category = "quan"; attrs.allowedCategories = ["quan"]; }
  else if (has("so mi|thun|croptop|crop top|blouse|ao len|ao kieu|ao crop|crop|polo|shirt|t shirt|sweater|top")) { attrs.category = "ao"; attrs.allowedCategories = ["ao"]; }
  else if (has("ao")) { attrs.category = "ao"; attrs.allowedCategories = ["ao", "ao-khoac"]; }
  else if (has("giay|dep|sandal|shoes?|heels?|sneakers?|boots?")) { attrs.category = "giay-dep"; attrs.allowedCategories = ["giay-dep"]; }
  else if (has("phu kien|accessor\\w*")) { attrs.allowedCategories = ACCESSORY_CATEGORY_SLUGS; }
  else if (has("tui|khan|that lung|non|mu|kinh|hat|bag|scarf|belt|glasses?")) { attrs.category = "phu-kien"; attrs.allowedCategories = ["phu-kien"]; }
  else if (/(?<!\p{L})đồ(?!\p{L})/u.test(lower)) { attrs.allowedCategories = GARMENT_CATEGORY_SLUGS; }

  // Colour: the longest matching synonym wins, so "xanh lá" is green, not blue.
  let best: { family: string; length: number } | null = null;
  for (const [family, synonyms] of Object.entries(COLOR_FAMILIES)) {
    for (const synonym of synonyms) {
      if (synonym.length > (best?.length ?? 0) && matchesAnySynonym([synonym], lower)) best = { family, length: synonym.length };
    }
  }
  if (best) { attrs.colorFamily = best.family; attrs.color = COLOR_FAMILY_LABELS[best.family]; }

  if (has("tay dai|dai tay|long sleeve")) attrs.sleeve = "tay dài";
  else if (has("tay ngan|ngan tay|short sleeve")) attrs.sleeve = "tay ngắn";
  else if (has("khong tay|sat nach|sleeveless")) attrs.sleeve = "không tay";

  if (has("om|fitted|bodycon|slim")) attrs.fit = "ôm";
  else if (has("rong|oversized?|loose")) attrs.fit = "rộng";
  else if (has("xoe|flared?")) attrs.fit = "xòe";
  else if (has("suong|straight")) attrs.fit = "suông";

  for (const [pattern, style] of STYLE_MAP) if (has(pattern)) { attrs.style = style; break; }
  for (const [pattern, occasion] of OCCASION_MAP) if (has(pattern)) { attrs.occasion = occasion; break; }

  return attrs;
}