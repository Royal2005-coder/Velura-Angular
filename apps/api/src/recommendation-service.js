import { config } from "./config.js";
import { generateGeminiEmbedding, generateGeminiJson, isGeminiConfigured, vectorLiteral } from "./gemini-client.js";
import { HttpError } from "./http.js";
import { callRpc, selectOne, selectRows } from "./supabase.js";
import { guestStyleProfiles } from "./user/quiz.js";

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

export async function buildStyleProfileRecommendations(context, req) {
  let quiz = null;
  let fallbackData = { success: true, quiz: null, combos: [], categories: [] };

  try {
    quiz = await getStyleProfile(context, req);
    fallbackData = await buildRuleBasedRecommendations(quiz);
  } catch (dbError) {
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
  } catch (error) {
    const errorDetail = sanitizeAiError(error);
    console.error("[RECOMMENDATION] Gemini RAG failed, using rule-based fallback:", errorDetail);
    return { ...fallbackData, source: "rule_fallback_gemini_error", error: errorDetail };
  }
}

export async function buildProductEmbeddingText(product) {
  const category = product.category || {};
  const variants = Array.isArray(product.variants) ? product.variants : [];
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

async function getStyleProfile(context, req) {
  if (context?.profile?.user_id) {
    return selectOne("style_profile", { user_id: `eq.${context.profile.user_id}` });
  }

  const guestSessionId = req.headers["x-guest-session-id"] || "";
  if (!guestSessionId) return null;

  // Retrieve from in-memory guest store if available
  const inMemory = guestStyleProfiles.get(guestSessionId);
  if (inMemory) return inMemory;

  // Fallback to selectOne and handle cases where database column doesn't exist
  try {
    return await selectOne("style_profile", { guest_session_id: `eq.${guestSessionId}` }, { useAnonKey: true });
  } catch (err) {
    return null;
  }
}

async function matchProductsByVector(queryEmbedding, quiz) {
  const rows = await callRpc("match_products", {
    query_embedding: vectorLiteral(queryEmbedding),
    match_threshold: config.recommendationMatchThreshold,
    match_count: config.recommendationMatchCount,
    filter_size: buildSizeFilter(quiz)
  }, { useAnonKey: false });

  const products = (Array.isArray(rows) ? rows : [])
    .map(normalizeProduct)
    .filter((product) => product.product_id);

  return rankProductsForStyleProfile(products, quiz, { keepSemanticFallback: true })
    .slice(0, config.recommendationMatchCount);
}

async function buildRuleBasedRecommendations(quiz) {
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
      
      const uniqueIds = [...new Set(componentProductIds)];
      product.products = uniqueIds
        .map((id) => products.find((p) => p.product_id === id))
        .filter(Boolean);
      
      if ((!product.images || product.images.length === 0) && product.products.length > 0) {
        product.images = product.products.flatMap((p) => Array.isArray(p.images) ? p.images.slice(0, 1) : []).slice(0, 4);
      }
    }
  }

  const combos = products
    .filter((product) => product.is_combo)
    .map((product) => attachRecommendationScore(product, quiz))
    .filter((product) => product.recommendation_score >= 3.0)
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
    .filter((product) => product.recommendation_score >= 3.0)
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

async function fetchAllVariants() {
  let allVariants = [];
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

async function buildStylistCombos(quiz, products) {
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

  const result = await generateGeminiJson(prompt, COMBO_SCHEMA);
  const productById = new Map(products.map((product) => [product.product_id, product]));
  const combos = Array.isArray(result?.combos) ? result.combos : [];

  return combos.map((combo) => {
    const selected = uniqueIds(combo.product_ids)
      .map((id) => productById.get(id))
      .filter(Boolean)
      .slice(0, 4);
    if (selected.length < 2) return null;
    return formatGeneratedCombo(combo, selected);
  }).filter(Boolean);
}

function formatGeneratedCombo(combo, products) {
  const total = products.reduce((sum, product) => sum + Number(product.sale_price || product.base_price || 0), 0);
  return {
    product_id: `gemini-combo-${products.map((product) => product.product_id.slice(0, 8)).join("-")}`,
    is_combo: true,
    name: combo.combo_name || "Set phối đồ Velura",
    description: combo.reason || "",
    base_price: total,
    sale_price: total,
    images: products.flatMap((product) => Array.isArray(product.images) ? product.images.slice(0, 1) : []).slice(0, 4),
    products,
    product_ids: products.map((product) => product.product_id),
    reason: combo.reason || ""
  };
}

function groupProductsByCategory(products) {
  const groups = new Map();
  const sortedProducts = [...products].sort(compareRecommendedProducts);
  for (const product of sortedProducts) {
    const categoryId = product.category_id || "uncategorized";
    if (!groups.has(categoryId)) {
      groups.set(categoryId, {
        category_id: categoryId,
        category_name: product.category_name || product.category?.name || "Gợi ý Velura",
        category_slug: product.category_slug || product.category?.slug || "",
        products: []
      });
    }
    const group = groups.get(categoryId);
    group.products.push(product);
  }
  return [...groups.values()].filter((group) => group.products.length);
}

function hydrateProducts(products, categories, comboItems, variants) {
  return products.map((product) => {
    let productVariants = [];
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

function normalizeProduct(product) {
  const category = product.category || {};
  return {
    ...product,
    category_name: product.category_name || category.name || "",
    category_slug: product.category_slug || category.slug || "",
    variants: Array.isArray(product.variants) ? product.variants : []
  };
}

function buildProfileEmbeddingText(quiz, profile) {
  const budgetDisplay = {
    "under_300k": "Dưới 300k",
    "300k_700k": "300k – 700k",
    "700k_1.5m": "700k – 1.5 triệu",
    "above_1.5m": "Trên 1.5 triệu"
  };
  return [
    `Người dùng: ${profile?.full_name || "Khách hàng Velura"}`,
    `Dáng người: ${quiz.body_shape || ""}`,
    `Tông da: ${quiz.skin_tone || ""}`,
    `Phong cách yêu thích: ${arrayText(quiz.style_tags)}`,
    `Dịp mặc ưu tiên: ${arrayText(quiz.preferred_occasions)}`,
    `Thương hiệu yêu thích: ${arrayText(quiz.favorite_brands)}`,
    `Ngân sách: ${budgetDisplay[quiz.budget_range] || quiz.budget_range || ""}`,
    `Chiều cao: ${quiz.height_cm || ""}cm`,
    `Cân nặng: ${quiz.weight_kg || ""}kg`
  ].join(" | ");
}

function buildSizeFilter(quiz) {
  return {
    clothing_size: quiz?.clothing_size || quiz?.size || "",
    shoe_size: quiz?.shoe_size || ""
  };
}

function formatQuiz(quiz) {
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

function formatProductForPrompt(product) {
  return {
    product_id: product.product_id,
    name: product.name,
    category: product.category_name,
    color_tone: product.color_tone,
    price: Number(product.sale_price || product.base_price || 0),
    style_tags: product.style_tags || [],
    suitable_body_shapes: product.suitable_body_shapes || [],
    sizes: [...new Set((product.variants || []).map((variant) => variant.size).filter(Boolean))]
  };
}

function hasStyleSignal(quiz) {
  return Boolean(quiz?.body_shape || (Array.isArray(quiz?.style_tags) && quiz.style_tags.length));
}

function rankProductsForStyleProfile(products, quiz, options = {}) {
  const ranked = products.map((product) => attachRecommendationScore(product, quiz));
  const strictMatches = ranked.filter((product) => product.recommendation_score >= 3.0);
  if (strictMatches.length || !options.keepSemanticFallback) {
    return strictMatches.sort(compareRecommendedProducts);
  }
  return ranked.sort(compareRecommendedProducts);
}

export function attachRecommendationScore(product, quiz) {
  const signals = buildStyleSignals(quiz);
  const productStyleTags = normalizedSet(product.style_tags);
  const productBodyShapes = normalizedSet(product.suitable_body_shapes);
  const productOccasions = normalizedSet(product.occasions);
  const productSkinTone = normalizeSignal(product.color_tone);
  const productCategory = normalizeSignal(product.category_name || product.category?.name || product.category_slug || "");
  const productText = normalizedSet([
    product.name,
    product.description,
    product.collection,
    product.brand,
    product.category_name,
    product.category_slug
  ]);

  let score = Number(product.similarity || 0) * 2;
  const reasons = [];

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

function compareRecommendedProducts(a, b) {
  return Number(b.recommendation_score || 0) - Number(a.recommendation_score || 0)
    || Number(b.similarity || 0) - Number(a.similarity || 0)
    || Number(Boolean(b.is_featured)) - Number(Boolean(a.is_featured))
    || String(a.name || "").localeCompare(String(b.name || ""), "vi");
}

function buildStyleSignals(quiz) {
  return {
    bodyShape: normalizeSignal(quiz?.body_shape),
    skinTone: normalizeSignal(quiz?.skin_tone),
    styleTags: normalizedSet(quiz?.style_tags),
    occasions: normalizedSet(quiz?.preferred_occasions),
    budget: normalizeSignal(quiz?.budget_range)
  };
}

function normalizedSet(values) {
  const input = Array.isArray(values) ? values : [values];
  const output = new Set();
  for (const value of input) {
    const normalized = normalizeSignal(value);
    if (normalized) output.add(normalized);
  }
  return output;
}

function normalizeSignal(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const compact = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  const aliases = {
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

function overlapCount(needles, haystack) {
  let count = 0;
  for (const value of needles) {
    if (haystack.has(value)) count += 1;
  }
  return count;
}

function isPriceInsideBudget(product, budget) {
  const price = Number(product.sale_price || product.base_price || 0);
  if (!price) return false;
  if (budget === "under_300k") return price <= 300000;
  if (budget === "300k_700k") return price >= 300000 && price <= 700000;
  if (budget === "700k_1.5m" || budget === "700k_1_5m" || budget === "700k_1.5" || budget === "700k_1_5") return price >= 700000 && price <= 1500000;
  if (budget === "above_1.5m" || budget === "above_1_5m" || budget === "above_1.5" || budget === "above_1_5") return price >= 1500000;
  return false;
}

function arrayText(value) {
  return Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value || "");
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function sanitizeAiError(error) {
  if (error instanceof HttpError) {
    return { code: error.code, status: error.status, details: error.details };
  }
  return { message: error?.message || "unknown" };
}
