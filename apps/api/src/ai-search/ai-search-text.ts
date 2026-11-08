import { HttpError } from "../http.js";

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