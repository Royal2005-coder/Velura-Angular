import { config } from "./config.js";
import { generateGeminiEmbedding, generateGeminiJson, isGeminiConfigured, vectorLiteral } from "./gemini-client.js";
import { HttpError } from "./http.js";
import { callRpc, selectOne, selectRows } from "./supabase.js";
import { guestStyleProfiles } from "./user/quiz.js";
import {
  asJsonObject,
  asString,
  isJsonObject,
  type AuthContext,
  type HttpRequest,
  type JsonObject
} from "./types.js";

const PRODUCT_SELECT = [
  "product_id",
  "sku",
  "is_combo",
  "name",
  "slug",
  "description",
  "category_id",
  "brand",
  "base_price",
  "sale_price",
  "images",
  "style_tags",
  "color_tone",
  "occasions",
  "suitable_body_shapes",
  "status",
  "is_featured",
  "collection",
  "category:category(category_id,name,slug)",
  "variants:variant(variant_id,color,color_hex,size,stock_quantity,reserved_quantity)"
].join(",");

const COMBO_SCHEMA = {
  type: "object",
  properties: {
    combos: {
      type: "array",
      description: "Danh sách 1-5 set đồ được gợi ý",
      items: {
        type: "object",
        properties: {
          combo_name: { type: "string", description: "Tên set đồ" },
          reason: { type: "string", description: "Lý do gợi ý (tiếng Việt)" },
          product_ids: {
            type: "array",
            description: "Danh sách 2-4 product_id từ danh sách ứng viên",
            items: { type: "string" }
          }
        },
        required: ["combo_name", "reason", "product_ids"]
      }
    }
  },
  required: ["combos"]
};

interface RecommendationPayload {
  success: boolean;
  quiz: JsonObject | null;
  combos: JsonObject[];
  categories: JsonObject[];
  source?: string;
  error?: unknown;
}

interface CategoryGroup extends JsonObject {
  products: JsonObject[];
}

/**
 * Hybrid RAG style-profile recommendations, with rule-based fallback.
 */
export async function buildStyleProfileRecommendations(
  context: AuthContext,
  req: HttpRequest
): Promise<RecommendationPayload> {
  let quiz: JsonObject | null = null;
  let fallbackData: RecommendationPayload = { success: true, quiz: null, combos: [], categories: [] };

  try {
    quiz = await getStyleProfile(context, req);
    fallbackData = await buildRuleBasedRecommendations(quiz);
  } catch (dbError: unknown) {
    console.error("[RECOMMENDATION DB ERROR]:", sanitizeAiError(dbError));
    return { success: true, quiz: null, combos: [], categories: [], source: "db_error" };
  }

  const geminiConfigured = isGeminiConfigured();
  if (!quiz || !hasStyleSignal(quiz) || !geminiConfigured) {
    const reason = !quiz ? "no_quiz" : !hasStyleSignal(quiz) ? "no_style_signal" : "no_gemini_key";
    console.warn(`[RECOMMENDATION] Using rule-based fallback: ${reason}`);
    return { ...fallbackData, source: geminiConfigured ? "rule_fallback" : "rule_fallback_no_gemini_key" };
  }

  try {
    const queryText = buildProfileEmbeddingText(quiz, context.profile);
    console.log(`[RECOMMENDATION] Generating embedding for quiz profile...`);
    const queryEmbedding = await generateGeminiEmbedding(`task: search result | query: ${queryText}`);
    console.log(`[RECOMMENDATION] Embedding generated (${queryEmbedding.length} dims). Matching products...`);
    const candidates = await matchProductsByVector(queryEmbedding, quiz);
    console.log(`[RECOMMENDATION] Found ${candidates.length} vector matches`);

    if (!candidates.length) {
      console.warn("[RECOMMENDATION] No vector matches found, using rule-based fallback");
      return { ...fallbackData, source: "rule_fallback_no_vector_matches" };
    }

    console.log(`[RECOMMENDATION] Generating AI combos from ${candidates.length} candidates...`);
    const combos = await buildStylistCombos(quiz, candidates);
    console.log(`[RECOMMENDATION] Generated ${combos.length} AI combos`);
    const categories = groupProductsByCategory(candidates);
    return {
      success: true,
      quiz: formatQuiz(quiz),
      combos: combos.length ? combos : fallbackData.combos,
      categories: categories.length ? categories : fallbackData.categories,
      source: "gemini_rag"
    };
  } catch (error: unknown) {
    const errorDetail = sanitizeAiError(error);
    console.error("[RECOMMENDATION] Gemini RAG failed, using rule-based fallback:", errorDetail);
    return { ...fallbackData, source: "rule_fallback_gemini_error", error: errorDetail };
  }
}

/**
 * Flatten a product row into embedding text for Gemini.
 */
export async function buildProductEmbeddingText(product: JsonObject): Promise<string> {
  const category = asJsonObject(product.category);
  const variants = asObjectList(product.variants);
  const sizes = [...new Set(variants.map((variant) => variant.size).filter(Boolean))].slice(0, 16);
  const colors = [...new Set(variants.map((variant) => variant.color).filter(Boolean))].slice(0, 16);

  return [
    `title: ${product.name || "Sản phẩm Velura"}`,
    `text: ${product.description || ""}`,
    `Danh mục: ${category.name || product.category_name || ""}`,
    `Thương hiệu: ${product.brand || "Velura"}`,
    `Màu chủ đạo: ${product.color_tone || ""}`,
    `Phong cách: ${arrayText(product.style_tags)}`,
    `Dịp mặc: ${arrayText(product.occasions)}`,
    `Dáng người phù hợp: ${arrayText(product.suitable_body_shapes)}`,
    `Size có sẵn: ${sizes.join(", ")}`,
    `Màu biến thể: ${colors.join(", ")}`,
    `Giá: ${Number(product.sale_price || product.base_price || 0)}`
  ].join(" | ");
}

async function getStyleProfile(context: AuthContext, req: HttpRequest): Promise<JsonObject | null> {
  if (context?.profile?.user_id) {
    return selectOne("style_profile", { user_id: `eq.${context.profile.user_id}` });
  }

  const guestSessionId = req.headers["x-guest-session-id"] || "";
  if (!guestSessionId) return null;

  // Retrieve from in-memory guest store if available
  const inMemory = guestStyleProfiles.get(guestSessionId);
  if (inMemory) return asJsonObject(inMemory);

  // Fallback to selectOne and handle cases where database column doesn't exist
  try {
    return await selectOne("style_profile", { guest_session_id: `eq.${guestSessionId}` }, { useAnonKey: true });
  } catch {
    return null;
  }
}

async function matchProductsByVector(queryEmbedding: number[], quiz: JsonObject): Promise<JsonObject[]> {
  const rows = await callRpc("match_products", {
    query_embedding: vectorLiteral(queryEmbedding),
    match_threshold: config.recommendationMatchThreshold,
    match_count: config.recommendationMatchCount,
    filter_size: buildSizeFilter(quiz)
  }, { useAnonKey: false });

  const products = (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeProduct(asJsonObject(row)))
    .filter((product) => product.product_id);

  return rankProductsForStyleProfile(products, quiz, { keepSemanticFallback: true })
    .slice(0, config.recommendationMatchCount);
}

async function buildRuleBasedRecommendations(quiz: JsonObject | null): Promise<RecommendationPayload> {
  const [productsResult, categoriesResult, comboItemsResult, variantsResult] = await Promise.all([
    selectRows("product", { select: PRODUCT_SELECT, status: "eq.on_sale" }, { useAnonKey: true }),
    selectRows("category", {}, { useAnonKey: true }),
    selectRows("combo_item", {}, { useAnonKey: true }),
    fetchAllVariants()
  ]);

  const products = hydrateProducts(productsResult.rows, categoriesResult.rows, comboItemsResult.rows, variantsResult.rows);

  // Populate component products and images list for combos
  for (const product of products) {
    if (product.is_combo) {
      const componentProductIds = (comboItemsResult.rows || [])
        .filter((item) => item.combo_product_id === product.product_id)
        .map((item) => item.component_product_id)
        .filter(Boolean);

      const uniqueComponentIds = [...new Set(componentProductIds)];
      const nestedProducts = uniqueComponentIds
        .map((id) => products.find((candidate) => candidate.product_id === id))
        .filter((candidate): candidate is JsonObject => Boolean(candidate));
      product.products = nestedProducts;

      if ((!product.images || collectionLength(product.images) === 0) && nestedProducts.length > 0) {
        product.images = nestedProducts.flatMap((nested) => {
          const images: unknown[] = Array.isArray(nested.images) ? nested.images : [];
          return images.slice(0, 1);
        }).slice(0, 4);
      }
    }
  }

  const combos = products
    .filter((product) => product.is_combo)
    .map((product) => attachRecommendationScore(product, quiz))
    .filter((product) => Number(product.recommendation_score) >= 3.0)
    .sort(compareRecommendedProducts)
    .slice(0, 5);
  const fallbackCombos = combos.length ? combos : products
    .filter((product) => product.is_combo)
    .map((product) => attachRecommendationScore(product, quiz))
    .sort(compareRecommendedProducts)
    .slice(0, 5);

  const singles = products
    .filter((product) => !product.is_combo)
    .map((product) => attachRecommendationScore(product, quiz))
    .filter((product) => Number(product.recommendation_score) >= 3.0)
    .sort(compareRecommendedProducts);
  const fallbackSingles = singles.length ? singles : products
    .filter((product) => !product.is_combo)
    .map((product) => attachRecommendationScore(product, quiz))
    .sort(compareRecommendedProducts)
    .slice(0, 24);

  return {
    success: true,
    quiz: formatQuiz(quiz),
    combos: fallbackCombos,
    categories: groupProductsByCategory(fallbackSingles)
  };
}

async function fetchAllVariants(): Promise<{ rows: JsonObject[] }> {
  let allVariants: JsonObject[] = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const { rows } = await selectRows("variant", { limit, offset }, { useAnonKey: true });
    allVariants = allVariants.concat(rows);
    if (rows.length < limit) break;
    offset += limit;
  }
  return { rows: allVariants };
}

async function buildStylistCombos(quiz: JsonObject, products: JsonObject[]): Promise<JsonObject[]> {
  const prompt = [
    "Bạn là AI Stylist cao cấp của Velura.",
    "Chỉ được chọn product_id từ danh sách sản phẩm được cấp. Không bịa sản phẩm.",
    "Hãy phối tối đa 5 set đồ, mỗi set 2-4 sản phẩm, ưu tiên cân bằng áo/quần/đầm/phụ kiện/giày nếu có.",
    "Reason viết tiếng Việt, ngắn gọn, nêu rõ vì sao hợp dáng người và phong cách của user.",
    "",
    "STYLE PROFILE:",
    JSON.stringify(formatQuiz(quiz)),
    "",
    "CANDIDATE PRODUCTS:",
    JSON.stringify(products.slice(0, 24).map(formatProductForPrompt))
  ].join("\n");

  const result = asJsonObject(await generateGeminiJson(prompt, COMBO_SCHEMA));
  const productById = new Map(products.map((product) => [product.product_id, product]));
  const rawCombos: unknown[] = Array.isArray(result.combos) ? result.combos : [];

  return rawCombos.map((combo) => {
    const comboObject = asJsonObject(combo);
    const selected = uniqueIds(comboObject.product_ids)
      .map((id) => productById.get(id))
      .filter((product): product is JsonObject => Boolean(product))
      .slice(0, 4);
    if (selected.length < 2) return null;
    return formatGeneratedCombo(comboObject, selected);
  }).filter((combo): combo is JsonObject => Boolean(combo));
}

function formatGeneratedCombo(combo: JsonObject, products: JsonObject[]): JsonObject {
  const total = products.reduce((sum, product) => sum + Number(product.sale_price || product.base_price || 0), 0);
  return {
    product_id: `gemini-combo-${products.map((product) => String(product.product_id).slice(0, 8)).join("-")}`,
    is_combo: true,
    name: combo.combo_name || "Set phối đồ Velura",
    description: combo.reason || "",
    base_price: total,
    sale_price: total,
    images: products.flatMap((product) => {
      const images: unknown[] = Array.isArray(product.images) ? product.images : [];
      return images.slice(0, 1);
    }).slice(0, 4),
    products,
    product_ids: products.map((product) => product.product_id),
    reason: combo.reason || ""
  };
}

function groupProductsByCategory(products: JsonObject[]): JsonObject[] {
  const groups = new Map<string, CategoryGroup>();
  const sortedProducts = [...products].sort(compareRecommendedProducts);
  for (const product of sortedProducts) {
    const categoryId = String(product.category_id || "uncategorized");
    const category = asJsonObject(product.category);
    if (!groups.has(categoryId)) {
      groups.set(categoryId, {
        category_id: product.category_id || "uncategorized",
        category_name: product.category_name || category.name || "Gợi ý Velura",
        category_slug: product.category_slug || category.slug || "",
        products: []
      });
    }
    const group = groups.get(categoryId);
    if (group) group.products.push(product);
  }
  return [...groups.values()].filter((group) => group.products.length);
}

function hydrateProducts(
  products: JsonObject[],
  categories: JsonObject[],
  comboItems: JsonObject[],
  variants: JsonObject[]
): JsonObject[] {
  return products.map((product) => {
    let productVariants: JsonObject[] = [];
    if (product.is_combo) {
      const componentProductIds = comboItems
        .filter((item) => item.combo_product_id === product.product_id)
        .map((item) => item.component_product_id)
        .filter(Boolean);
      productVariants = variants
        .filter((variant) => componentProductIds.includes(variant.product_id))
        .map((variant) => ({ ...variant, combo_product_id: product.product_id }));
    } else {
      productVariants = variants.filter((variant) => variant.product_id === product.product_id);
    }
    const category = categories.find((item) => item.category_id === product.category_id) || {};
    return normalizeProduct({ ...product, variants: productVariants, category });
  });
}

function normalizeProduct(product: JsonObject): JsonObject {
  const category = asJsonObject(product.category);
  return {
    ...product,
    category_name: product.category_name || category.name || "",
    category_slug: product.category_slug || category.slug || "",
    variants: Array.isArray(product.variants) ? product.variants : []
  };
}

function buildProfileEmbeddingText(quiz: JsonObject, profile: JsonObject | null | undefined): string {
  const budgetDisplay: Record<string, string> = {
    "under_300k": "Dưới 300k",
    "300k_700k": "300k – 700k",
    "700k_1.5m": "700k – 1.5 triệu",
    "above_1.5m": "Trên 1.5 triệu"
  };
  const budgetKey = asString(quiz.budget_range);
  return [
    `Người dùng: ${profile?.full_name || "Khách hàng Velura"}`,
    `Dáng người: ${quiz.body_shape || ""}`,
    `Tông da: ${quiz.skin_tone || ""}`,
    `Phong cách yêu thích: ${arrayText(quiz.style_tags)}`,
    `Dịp mặc ưu tiên: ${arrayText(quiz.preferred_occasions)}`,
    `Thương hiệu yêu thích: ${arrayText(quiz.favorite_brands)}`,
    `Ngân sách: ${budgetDisplay[budgetKey] || quiz.budget_range || ""}`,
    `Chiều cao: ${quiz.height_cm || ""}cm`,
    `Cân nặng: ${quiz.weight_kg || ""}kg`
  ].join(" | ");
}

function buildSizeFilter(quiz: JsonObject | null): JsonObject {
  return {
    clothing_size: quiz?.clothing_size || quiz?.size || "",
    shoe_size: quiz?.shoe_size || ""
  };
}

function formatQuiz(quiz: JsonObject | null): JsonObject | null {
  if (!quiz) return null;
  return {
    profile_id: quiz.profile_id,
    body_shape: quiz.body_shape,
    skin_tone: quiz.skin_tone,
    style_tags: quiz.style_tags,
    preferred_occasions: quiz.preferred_occasions,
    favorite_brands: quiz.favorite_brands,
    favorite_colors: quiz.favorite_colors,
    budget_range: quiz.budget_range,
    age_group: quiz.age_group,
    height_cm: quiz.height_cm,
    weight_kg: quiz.weight_kg,
    chest_cm: quiz.chest_cm,
    waist_cm: quiz.waist_cm,
    hip_cm: quiz.hip_cm,
    clothing_size: quiz.clothing_size || quiz.size || null,
    shoe_size: quiz.shoe_size || null
  };
}

function formatProductForPrompt(product: JsonObject): JsonObject {
  const variants = asObjectList(product.variants);
  return {
    product_id: product.product_id,
    name: product.name,
    category: product.category_name,
    color_tone: product.color_tone,
    price: Number(product.sale_price || product.base_price || 0),
    style_tags: product.style_tags || [],
    suitable_body_shapes: product.suitable_body_shapes || [],
    sizes: [...new Set(variants.map((variant) => variant.size).filter(Boolean))]
  };
}

function hasStyleSignal(quiz: JsonObject | null): boolean {
  return Boolean(quiz?.body_shape || (Array.isArray(quiz?.style_tags) && quiz.style_tags.length));
}

function rankProductsForStyleProfile(
  products: JsonObject[],
  quiz: JsonObject | null,
  options: { keepSemanticFallback?: boolean } = {}
): JsonObject[] {
  const ranked = products.map((product) => attachRecommendationScore(product, quiz));
  const strictMatches = ranked.filter((product) => Number(product.recommendation_score) >= 3.0);
  if (strictMatches.length || !options.keepSemanticFallback) {
    return strictMatches.sort(compareRecommendedProducts);
  }
  return ranked.sort(compareRecommendedProducts);
}

/**
 * Attach a style-match score and reason tags to one product row.
 */
export function attachRecommendationScore(product: JsonObject, quiz: JsonObject | null): JsonObject {
  const signals = buildStyleSignals(quiz);
  const productStyleTags = normalizedSet(product.style_tags);
  const productBodyShapes = normalizedSet(product.suitable_body_shapes);
  const productOccasions = normalizedSet(product.occasions);
  const productSkinTone = normalizeSignal(product.color_tone);
  const category = asJsonObject(product.category);
  const productCategory = normalizeSignal(product.category_name || category.name || product.category_slug || "");
  const productText = normalizedSet([
    product.name,
    product.description,
    product.collection,
    product.brand,
    product.category_name,
    product.category_slug
  ]);

  let score = Number(product.similarity || 0) * 2;
  const reasons: string[] = [];

  const styleMatches = overlapCount(signals.styleTags, productStyleTags);
  if (styleMatches) {
    score += styleMatches * 4;
    reasons.push("style");
  }

  if (signals.bodyShape && productBodyShapes.has(signals.bodyShape)) {
    score += 5;
    reasons.push("body_shape");
  }

  if (signals.skinTone && productSkinTone === signals.skinTone) {
    score += 2;
    reasons.push("skin_tone");
  }

  const occasionMatches = overlapCount(signals.occasions, productOccasions);
  if (occasionMatches) {
    score += occasionMatches * 3;
    reasons.push("occasion");
  }

  const textMatches = overlapCount(new Set([...signals.styleTags, ...signals.occasions]), productText);
  if (textMatches) {
    score += Math.min(textMatches, 2);
  }

  if (signals.budget && isPriceInsideBudget(product, signals.budget)) {
    score += 1;
    reasons.push("budget");
  }

  if (product.is_featured) score += 0.25;

  return {
    ...product,
    recommendation_score: Number(score.toFixed(4)),
    recommendation_reasons: reasons
  };
}

function compareRecommendedProducts(a: JsonObject, b: JsonObject): number {
  return Number(b.recommendation_score || 0) - Number(a.recommendation_score || 0)
    || Number(b.similarity || 0) - Number(a.similarity || 0)
    || Number(Boolean(b.is_featured)) - Number(Boolean(a.is_featured))
    || String(a.name || "").localeCompare(String(b.name || ""), "vi");
}

function buildStyleSignals(quiz: JsonObject | null): {
  bodyShape: string;
  skinTone: string;
  styleTags: Set<string>;
  occasions: Set<string>;
  budget: string;
} {
  return {
    bodyShape: normalizeSignal(quiz?.body_shape),
    skinTone: normalizeSignal(quiz?.skin_tone),
    styleTags: normalizedSet(quiz?.style_tags),
    occasions: normalizedSet(quiz?.preferred_occasions),
    budget: normalizeSignal(quiz?.budget_range)
  };
}

function normalizedSet(values: unknown): Set<string> {
  const input: unknown[] = Array.isArray(values) ? values : [values];
  const output = new Set<string>();
  for (const value of input) {
    const normalized = normalizeSignal(value);
    if (normalized) output.add(normalized);
  }
  return output;
}

function normalizeSignal(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const compact = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  const aliases: Record<string, string> = {
    minimalism: "minimalist",
    toi_gian: "minimalist",
    thanh_lich: "elegant",
    sang_trong: "elegant",
    lang_man: "romantic",
    nu_tinh: "romantic",
    co_dien: "classic",
    cong_so: "office",
    van_phong: "office",
    du_tiec: "party",
    tiec: "party",
    hen_ho: "party",
    di_choi: "casual",
    dao_pho: "casual",
    du_lich: "travel",
    dong_ho_cat: "hourglass",
    dang_dong_ho_cat: "hourglass",
    qua_le: "pear",
    dang_qua_le: "pear",
    qua_tao: "apple",
    dang_qua_tao: "apple",
    chu_nhat: "rectangle",
    dang_chu_nhat: "rectangle",
    tam_giac_nguoc: "inverted_triangle",
    inverted_triangle: "inverted_triangle",
    smart_casual: "smart_casual"
  };

  return aliases[compact] || compact;
}

function overlapCount(needles: Iterable<string>, haystack: Set<string>): number {
  let count = 0;
  for (const value of needles) {
    if (haystack.has(value)) count += 1;
  }
  return count;
}

function isPriceInsideBudget(product: JsonObject, budget: string): boolean {
  const price = Number(product.sale_price || product.base_price || 0);
  if (!price) return false;
  if (budget === "under_300k") return price <= 300000;
  if (budget === "300k_700k") return price >= 300000 && price <= 700000;
  if (budget === "700k_1.5m" || budget === "700k_1_5m" || budget === "700k_1.5" || budget === "700k_1_5") return price >= 700000 && price <= 1500000;
  if (budget === "above_1.5m" || budget === "above_1_5m" || budget === "above_1.5" || budget === "above_1_5") return price >= 1500000;
  return false;
}

function arrayText(value: unknown): string {
  return Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value || "");
}

function uniqueIds(values: unknown): string[] {
  const list: unknown[] = Array.isArray(values) ? values : [];
  return [...new Set(list.map((value) => String(value || "").trim()).filter(Boolean))];
}

function sanitizeAiError(error: unknown): JsonObject {
  if (error instanceof HttpError) {
    return { code: error.code, status: error.status, details: error.details };
  }
  const message = error instanceof Error
    ? error.message
    : isJsonObject(error)
      ? error.message
      : undefined;
  return { message: message || "unknown" };
}

function asObjectList(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asJsonObject(item));
}

function collectionLength(value: unknown): number {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  if (isJsonObject(value)) return Number(value.length) || 0;
  return 0;
}
