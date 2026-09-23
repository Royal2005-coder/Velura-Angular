import { config } from "../config.js";
import { generateGeminiText, isGeminiConfigured } from "../gemini-client.js";
import { asJsonObject, asNumber, asString, errorMessage, isJsonObject, type JsonObject } from "../types.js";
import type { ChatbotRepository } from "./chatbot-repository.js";

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

const SYSTEM_PROMPT = `Bạn là Velura Stylist - trợ lý thời trang AI chuyên nghiệp của cửa hàng thời trang Velura tại Việt Nam. Bạn đại diện cho phong cách thương hiệu thanh lịch, tinh tế, gần gũi và có gu. Nhiệm vụ của bạn là hướng dẫn khách trò chuyện, tư vấn phong cách, gợi ý sản phẩm thật, hỗ trợ đơn hàng/chính sách.

PHONG CÁCH THƯƠNG HIỆU:
- Xưng "mình", gọi khách là "bạn"; lịch sự, ấm áp, tự tin, không cứng nhắc.
- Viết tiếng Việt tự nhiên, sang trọng vừa đủ, dễ hiểu, không dùng biệt ngữ kỹ thuật.
- Trả lời gọn nhưng đủ ý; ưu tiên 2-5 gạch đầu dòng khi cần hướng dẫn lựa chọn.
- Mỗi câu trả lời nên có bước tiếp theo rõ ràng: hỏi thêm số đo, dịp mặc, ngân sách, màu yêu thích, mã đơn hàng hoặc thông tin liên hệ.
- Không hứa chắc quá mức về tồn kho, thời gian xử lý hoặc quyết định của nhân viên. Chỉ nói theo dữ liệu/tool.

CẤU TRÚC TRẢ LỜI CHUYÊN NGHIỆP:
- Mở đầu bằng 1 câu xác nhận đúng nhu cầu của khách.
- Nếu là tư vấn thời trang, đưa 3-5 gợi ý cụ thể về phom dáng, màu sắc, chất liệu, phụ kiện hoặc dịp mặc.
- Nếu có sản phẩm từ tool, nhắc tên sản phẩm thật và lý do phù hợp; không tự thêm sản phẩm ngoài dữ liệu.
- Nếu thiếu dữ liệu cá nhân hóa, hỏi tối đa 2 câu quan trọng nhất để tiếp tục tư vấn.
- Tuyệt đối không trả về lỗi kỹ thuật thô như "Failed to fetch", "network error", "tool error". Hãy diễn giải thân thiện: hệ thống đang chưa kết nối được và hướng dẫn bước tiếp theo.

MỞ ĐẦU VÀ HƯỚNG DẪN:
- Khi khách chào hỏi, bắt đầu cuộc trò chuyện mới hoặc chưa nêu nhu cầu rõ ràng, hãy giới thiệu ngắn: "Mình là Velura Stylist" và nêu các khả năng chính: gợi ý outfit, tìm sản phẩm, tư vấn size, tra cứu đơn hàng/chính sách.
- Gợi ý 2-3 câu khách có thể nhắn, ví dụ: "Gợi ý outfit công sở thanh lịch", "Tìm váy dự tiệc dưới 800.000đ", "Tư vấn size cho mình: cao 1m60, nặng 50kg".

NGUYÊN TẮC DỮ LIỆU VÀ TOOL:
- Khi khách hỏi về sản phẩm, mẫu mã, giá, tồn kho hoặc muốn gợi ý mua sắm, PHẢI dùng tool search_products để tìm sản phẩm thật từ database.
- Khi khách hỏi về danh mục, dùng tool get_categories.
- Khi khách hỏi chi tiết một sản phẩm cụ thể và có product_id, dùng tool get_product_detail.
- Khi khách hỏi kiểm tra đơn hàng, hãy xin mã đơn hàng hoặc số điện thoại nếu chưa có; khi đã có thông tin thì dùng tool get_order_status.
- Khi khách chia sẻ số đo, chiều cao, cân nặng, dáng người hoặc tông da, hãy đề xuất lưu hồ sơ phong cách và dùng tool update_style_profile nếu có userId.
- Khi khách yêu cầu gặp nhân viên, CSKH, tư vấn viên hoặc người thật, hãy trả lời thân thiện rằng bạn là AI và sẽ cố gắng hỗ trợ tốt nhất. Nếu khách cần hỗ trợ thêm, nhân viên CSKH sẽ tham gia trò chuyện.

THÔNG TIN CHÍNH SÁCH CỐ ĐỊNH:
- Bảng size: S(eo 62-66cm, ngực 80-84cm), M(eo 66-70cm, ngực 84-88cm), L(eo 70-74cm, ngực 88-92cm), XL(eo 74-78cm, ngực 92-96cm).
- Với bất kỳ câu hỏi nào về chính sách đổi trả, hoàn tiền, vận chuyển, giao nhận hoặc điều khoản thành viên, bạn BẮT BUỘC phải sử dụng tool search_policies hoặc get_policies để lấy thông tin chính xác nhất từ database trước khi trả lời. Database là nguồn đúng duy nhất. Nếu tool không trả về kết quả, hãy nói rõ rằng hiện chưa tải được chính sách mới nhất từ database và đề nghị khách liên hệ CSKH; tuyệt đối không tự dùng chính sách mặc định hoặc dữ liệu cũ.

- Không đưa lời khuyên y tế/pháp lý/tài chính. Với vấn đề ngoài phạm vi thời trang/cửa hàng, hãy lịch sự chuyển hướng hoặc đề nghị CSKH hỗ trợ.
- Tuyệt đối KHÔNG hiển thị bất kỳ dòng phân tích, tự đánh giá, hoặc danh sách kiểm tra quy tắc nào (như "Review against constraints", "Role: Velura Stylist? Yes",...) trong câu trả lời. Hãy bắt đầu trực tiếp bằng câu chào hoặc nội dung tư vấn thân thiện cho khách.`;

interface ToolDefinition {
  type: string;
  name: string;
  description: string;
  parameters: JsonObject;
}

/**
 * Gemini / Mistral chat result consumed by `createChatbotService`.
 */
export interface LlmChatResult {
  text: string;
  productIds: unknown[];
  blogIds?: unknown[];
  used: boolean;
  intent: string;
  interactionId?: unknown;
  createdTicket?: JsonObject | null;
  metadata?: JsonObject;
}

/**
 * LLM facade used by the chatbot service.
 */
export interface LlmService {
  chat(
    messages: JsonObject[],
    contextProducts?: JsonObject[],
    previousInteractionId?: unknown,
    styleProfile?: JsonObject | null,
    userId?: string | null
  ): Promise<LlmChatResult>;
}

const GEMINI_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    name: "search_products",
    description: "Tìm kiếm sản phẩm thời trang trong database theo từ khóa. Trả về danh sách sản phẩm thật.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Từ khóa tìm kiếm (VD: 'váy dự tiệc', 'áo blazer', 'đầm công sở')"
        },
        limit: {
          type: "number",
          description: "Số lượng sản phẩm (mặc định 6)"
        }
      },
      required: ["query"]
    }
  },
  {
    type: "function",
    name: "get_categories",
    description: "Lấy danh sách tất cả danh mục sản phẩm",
    parameters: {
      type: "object",
      properties: {}
    }
  },
  {
    type: "function",
    name: "get_product_detail",
    description: "Lấy thông tin chi tiết một sản phẩm theo ID",
    parameters: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "ID sản phẩm (UUID)" }
      },
      required: ["product_id"]
    }
  },
  {
    type: "function",
    name: "get_policies",
    description: "Lấy toàn bộ chính sách công khai của Velura từ database: đổi trả, bảo mật, vận chuyển, điều khoản sử dụng, FAQ và thành viên.",
    parameters: {
      type: "object",
      properties: {}
    }
  },
  {
    type: "function",
    name: "get_order_status",
    description: "Kiểm tra trạng thái đơn hàng của khách hàng theo mã đơn hàng (UUID) hoặc số điện thoại.",
    parameters: {
      type: "object",
      properties: {
        order_query: { type: "string", description: "Mã đơn hàng (UUID) hoặc Số điện thoại nhận hàng của khách" }
      },
      required: ["order_query"]
    }
  },
  {
    type: "function",
    name: "update_style_profile",
    description: "Cập nhật hồ sơ phong cách thời trang của người dùng hiện tại (số đo ngực/eo/mông, chiều cao, cân nặng, dáng người, tông da) khi họ cung cấp thông tin.",
    parameters: {
      type: "object",
      properties: {
        height_cm: { type: "number", description: "Chiều cao tính bằng cm (VD: 165)" },
        weight_kg: { type: "number", description: "Cân nặng tính bằng kg (VD: 55)" },
        chest_cm: { type: "number", description: "Số đo vòng ngực tính bằng cm (VD: 85)" },
        waist_cm: { type: "number", description: "Số đo vòng eo tính bằng cm (VD: 64)" },
        hip_cm: { type: "number", description: "Số đo vòng mông tính bằng cm (VD: 90)" },
        body_shape: { type: "string", description: "Dáng người (pear, hourglass, rectangle, apple, inverted_triangle)" },
        skin_tone: { type: "string", description: "Tông da (fair, medium, dark)" }
      }
    }
  },
  {
    type: "function",
    name: "create_support_ticket",
    description: "Tạo một ticket hỗ trợ mới khi người dùng gặp sự cố phức tạp, lỗi hệ thống, khiếu nại hoặc cần người liên hệ.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Tiêu đề của ticket hỗ trợ (VD: Lỗi giao hàng, Hỗ trợ size đầm dạ hội)" },
        description: { type: "string", description: "Mô tả chi tiết sự cố hoặc yêu cầu hỗ trợ" },
        email: { type: "string", description: "Email liên hệ của khách hàng" },
        phone: { type: "string", description: "Số điện thoại liên hệ của khách hàng" }
      },
      required: ["title", "description"]
    }
  },
  {
    type: "function",
    name: "search_policies",
    description: "Tìm kiếm thông tin chính sách của Velura (đổi trả, vận chuyển, bảo mật, điều khoản) theo từ khóa.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Từ khóa chính sách cần tra cứu (VD: 'đổi hàng', 'phí ship', 'bảo mật')"
        }
      },
      required: ["query"]
    }
  },
  {
    type: "function",
    name: "search_blogs",
    description: "Tìm kiếm các bài viết xu hướng, cẩm nang phối đồ hoặc tin tức thời trang trên blog của Velura.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Từ khóa bài viết cần tìm (VD: 'blazer', 'tủ đồ capsule', 'quiet luxury')"
        }
      },
      required: ["query"]
    }
  }
];

/**
 * Build the Gemini / Mistral chat client around a chatbot repository.
 */
export function createLLMService({ repository }: { repository: ChatbotRepository }): LlmService {
  if (!repository) throw new TypeError("repository is required");
  return {
    async chat(messages, contextProducts = [], previousInteractionId = null, styleProfile = null, userId = null) {
      if (isGeminiConfigured()) {
        const geminiResult = await callGeminiChat(messages, repository, contextProducts, styleProfile, userId);
        if (geminiResult.used) {
          return geminiResult;
        }
        const geminiMeta = geminiResult.metadata || {};
        console.warn("[LLM] Gemini did not return a usable response, falling back to Mistral:", geminiMeta.error || "unknown");
      }
      return callMistralChat(messages, repository, contextProducts, styleProfile, userId);
    }
  };
}

async function callGeminiChat(
  messages: JsonObject[],
  repository: ChatbotRepository,
  contextProducts: JsonObject[] = [],
  styleProfile: JsonObject | null = null,
  userId: string | null = null
): Promise<LlmChatResult> {
  const lastUserText = getLastUserText(messages);
  console.log("[LLM] callGeminiChat called, model:", config.geminiModel || config.geminiStylistModel);

  try {
    const [policyContext, blogContext] = await Promise.all([
      shouldLoadPolicyContext(lastUserText) ? safeSearchPolicies(repository, lastUserText) : Promise.resolve([]),
      shouldLoadBlogContext(lastUserText) ? safeSearchBlogs(repository, lastUserText) : Promise.resolve([])
    ]);

    const prompt = buildGeminiChatPrompt({
      messages,
      contextProducts,
      policyContext,
      blogContext,
      styleProfile,
      userId,
      lastUserText
    });

    const finalText = await generateGeminiText(prompt, {
      model: config.geminiModel || config.geminiStylistModel,
      temperature: 0.35,
      maxOutputTokens: 1700,
      timeoutMs: Math.max(config.requestTimeoutMs || 15000, 20000)
    });

    const intent = detectGeminiIntent(lastUserText, policyContext, blogContext, contextProducts);
    const productIds = intent === "product_search" || intent === "size_query"
      ? inferProductIdsFromAnswer(finalText, contextProducts)
      : [];
    const blogIds = intent === "blog_search"
      ? blogContext.map((blog) => blog.blog_id).filter(Boolean).slice(0, 4)
      : [];

    console.log("[LLM] Gemini reply length:", finalText.length, "Products:", productIds.length, "Policies:", policyContext.length);
    return {
      text: finalText.trim().slice(0, 4000),
      productIds,
      blogIds,
      used: true,
      intent,
      interactionId: null,
      createdTicket: null,
      metadata: {
        provider: "gemini",
        model: config.geminiModel || config.geminiStylistModel,
        context: {
          products: contextProducts.length,
          policies: policyContext.length,
          blogs: blogContext.length,
          hasStyleProfile: Boolean(styleProfile)
        }
      }
    };
  } catch (error: unknown) {
    console.error("[LLM] Error in callGeminiChat:", errorMessage(error));
    return {
      text: "",
      productIds: [],
      blogIds: [],
      used: false,
      intent: "llm_error",
      metadata: { provider: "gemini", error: errorMessage(error) }
    };
  }
}

function buildGeminiChatPrompt(input: {
  messages: JsonObject[];
  contextProducts: JsonObject[];
  policyContext: JsonObject[];
  blogContext: JsonObject[];
  styleProfile: JsonObject | null;
  userId: string | null;
  lastUserText: string;
}): string {
  return `${SYSTEM_PROMPT}

NGUỒN DỮ LIỆU ĐÃ NẠP CHO LƯỢT TRẢ LỜI NÀY

1. Trạng thái người dùng
- userId: ${input.userId || "guest hoặc chưa xác định"}
${formatStyleProfileForPrompt(input.styleProfile)}

2. Sản phẩm thật từ database
${formatProductsForPrompt(input.contextProducts)}

3. Chính sách thật từ database
${formatPoliciesForPrompt(input.policyContext)}

4. Bài viết liên quan từ database
${formatBlogsForPrompt(input.blogContext)}

5. Lịch sử trò chuyện gần nhất
${formatMessagesForPrompt(input.messages)}

YÊU CẦU CUỐI CỦA KHÁCH
${input.lastUserText || "Khách chưa nêu rõ nhu cầu."}

QUY TẮC TRẢ LỜI BẮT BUỘC
- Trả lời bằng tiếng Việt tự nhiên, đúng vai trò Velura Stylist.
- Nếu tư vấn sản phẩm hoặc phối đồ, phải dựa trên sản phẩm trong mục 2, nêu rõ tên sản phẩm thật, giá nếu có, và lý do phù hợp với dáng người, màu sắc, phong cách hoặc dịp mặc.
- Nếu hỏi chính sách, chỉ dùng dữ liệu ở mục 3. Không dùng thông tin cũ như đổi trả 7 ngày hoặc 48 giờ nếu database nêu 30 ngày.
- Nếu dữ liệu chưa đủ, hỏi tối đa 2 câu ngắn để lấy thêm thông tin.
- Không nhắc lỗi kỹ thuật, tên API, embedding, vector hoặc database với khách hàng.
- Không bịa sản phẩm, giá, tồn kho, thời gian xử lý hoặc chính sách.`;
}

function formatStyleProfileForPrompt(styleProfile: JsonObject | null): string {
  if (!styleProfile) {
    return "- Style Profile: chưa có hoặc chưa tải được.";
  }
  return `- Style Profile:
  + Chiều cao: ${styleProfile.height_cm || "chưa rõ"} cm
  + Cân nặng: ${styleProfile.weight_kg || "chưa rõ"} kg
  + Số đo: ngực ${styleProfile.chest_cm || "chưa rõ"} cm, eo ${styleProfile.waist_cm || "chưa rõ"} cm, mông ${styleProfile.hip_cm || "chưa rõ"} cm
  + Dáng người: ${styleProfile.body_shape || "chưa rõ"}
  + Tông da: ${styleProfile.skin_tone || "chưa rõ"}
  + Phong cách: ${formatArray(styleProfile.style_tags)}
  + Dịp mặc ưu tiên: ${formatArray(styleProfile.preferred_occasions)}
  + Màu yêu thích: ${formatArray(styleProfile.favorite_colors)}
  + Size quần áo: ${styleProfile.clothing_size || "chưa rõ"}
  + Size giày: ${styleProfile.shoe_size || "chưa rõ"}
  + Ngân sách: ${styleProfile.budget_range || "chưa rõ"}`;
}

function formatProductsForPrompt(products: JsonObject[] = []): string {
  if (!products.length) {
    return "- Chưa có sản phẩm phù hợp được truy xuất ở lượt này.";
  }
  return products.slice(0, 10).map((product, index) => {
    const price = Number(product.sale_price || product.base_price || product.price || 0);
    const variants = Array.isArray(product.variants)
      ? product.variants.filter(isJsonObject).slice(0, 4).map((variant) => `${variant.color || "màu chưa rõ"} / ${variant.size || "size chưa rõ"} / tồn ${variant.stock_quantity ?? "?"}`).join("; ")
      : "";
    const category = isJsonObject(product.category) ? product.category : {};
    return `${index + 1}. ${product.name || "Sản phẩm"} | ID: ${product.product_id || ""} | Giá: ${price ? price.toLocaleString("vi-VN") + "đ" : "chưa rõ"} | SKU: ${product.sku || "chưa rõ"} | Danh mục: ${category.name || product.category_name || "chưa rõ"} | Tag: ${formatArray(product.tags)} | Feature: ${formatArray(product.features)} | Biến thể: ${variants || "chưa rõ"} | Mô tả: ${truncateText(product.description, 420)}`;
  }).join("\n");
}

function formatPoliciesForPrompt(policies: JsonObject[] = []): string {
  if (!policies.length) {
    return "- Không có chính sách liên quan được truy xuất ở lượt này.";
  }
  return policies.slice(0, 6).map((policy, index) => {
    return `${index + 1}. ${policy.title || policy.slug || "Chính sách"}\nTóm tắt: ${policy.summary || ""}\nNội dung: ${formatPolicyContent(policy.content)}`;
  }).join("\n\n");
}

function formatBlogsForPrompt(blogs: JsonObject[] = []): string {
  if (!blogs.length) {
    return "- Không có bài viết liên quan được truy xuất ở lượt này.";
  }
  return blogs.slice(0, 4).map((blog, index) => {
    return `${index + 1}. ${blog.title || "Bài viết"} | Tóm tắt: ${blog.excerpt || ""} | Nội dung: ${truncateText(blog.content, 700)}`;
  }).join("\n");
}

function formatMessagesForPrompt(messages: JsonObject[] = []): string {
  return messages.slice(-8).map((message) => {
    const role = message.sender === "user" ? "Khách" : "Velura Stylist";
    return `${role}: ${truncateText(message.text, 650)}`;
  }).join("\n") || "Chưa có lịch sử trò chuyện.";
}

function formatPolicyContent(content: unknown): string {
  if (Array.isArray(content)) {
    return content.map((section) => {
      const block = isJsonObject(section) ? section : {};
      const heading = block.heading ? `${block.heading}: ` : "";
      const body = Array.isArray(block.items) ? block.items.join("; ") : String(block.text || "");
      return heading + body;
    }).filter(Boolean).join(" | ");
  }
  if (typeof content === "string") {
    return truncateText(content, 1400);
  }
  return truncateText(JSON.stringify(content || {}), 1400);
}

function formatArray(value: unknown): string {
  return Array.isArray(value) && value.length ? value.join(", ") : "chưa rõ";
}

function truncateText(value: unknown, maxLength = 500): string {
  const text = String(value || "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

async function safeSearchPolicies(repository: ChatbotRepository, query: string): Promise<JsonObject[]> {
  try {
    const result = await repository.searchPolicies?.(query);
    return result?.rows || [];
  } catch (error: unknown) {
    console.warn("[LLM] Could not load policy context:", errorMessage(error));
    return [];
  }
}

async function safeSearchBlogs(repository: ChatbotRepository, query: string): Promise<JsonObject[]> {
  try {
    const result = await repository.searchBlogs?.(query);
    return result?.rows || [];
  } catch (error: unknown) {
    console.warn("[LLM] Could not load blog context:", errorMessage(error));
    return [];
  }
}

function getLastUserText(messages: JsonObject[] = []): string {
  const found = [...messages].reverse().find((message) => message.sender === "user");
  return asString(found?.text);
}

function normalizeText(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

function shouldLoadPolicyContext(text: string): boolean {
  const normalized = normalizeText(text);
  return /(chinh sach|doi tra|hoan tien|van chuyen|giao hang|phi ship|bao mat|dieu khoan|thanh vien|faq|cau hoi|ho tro|khieu nai|return|refund|shipping|privacy|policy)/.test(normalized);
}

function shouldLoadBlogContext(text: string): boolean {
  const normalized = normalizeText(text);
  return /(blog|bai viet|xu huong|cam nang|meo phoi|quiet luxury|capsule|phong cach)/.test(normalized);
}

function detectGeminiIntent(text: string, policies: JsonObject[] = [], blogs: JsonObject[] = [], products: JsonObject[] = []): string {
  const normalized = normalizeText(text);
  if (policies.length || shouldLoadPolicyContext(text)) return "policy_query";
  if (blogs.length || shouldLoadBlogContext(text)) return "blog_search";
  if (/(don hang|ma don|tracking|van don)/.test(normalized)) return "order_query";
  if (/(size|kich co|vong eo|vong nguc|vong mong|cao|nang)/.test(normalized)) return "size_query";
  if (products.length || /(ao|quan|dam|vay|giay|phu kien|set|outfit|phoi do|san pham|mua|mac|cong so|du tiec|blazer|dress|skirt|shirt)/.test(normalized)) return "product_search";
  return "general";
}

function inferProductIdsFromAnswer(answer: string, products: JsonObject[] = []): unknown[] {
  if (!products.length) return [];
  const normalizedAnswer = normalizeText(answer);
  const matched = products
    .filter((product) => product.product_id && product.name && normalizedAnswer.includes(normalizeText(product.name).slice(0, 40)))
    .map((product) => product.product_id);
  if (matched.length) {
    return [...new Set(matched)].slice(0, 6);
  }
  return products.map((product) => product.product_id).filter(Boolean).slice(0, 4);
}

async function callMistralChat(
  messages: JsonObject[],
  repository: ChatbotRepository,
  contextProducts: JsonObject[] = [],
  styleProfile: JsonObject | null = null,
  userId: string | null = null
): Promise<LlmChatResult> {
  const apiKey = config.mistralApiKey;
  console.log("[LLM] callMistralChat called, apiKey:", apiKey ? apiKey.substring(0, 8) + "..." : "MISSING");
  if (!apiKey) {
    console.log("[LLM] No API key, skipping");
    return { text: "", productIds: [], used: false, intent: "" };
  }

  let styleContext = "";
  if (styleProfile) {
    const styleTags = Array.isArray(styleProfile.style_tags) ? styleProfile.style_tags : [];
    const occasions = Array.isArray(styleProfile.preferred_occasions) ? styleProfile.preferred_occasions : [];
    styleContext = `\n\nStyle Profile của Khách hàng:
- Chiều cao: ${styleProfile.height_cm || "chưa rõ"} cm
- Cân nặng: ${styleProfile.weight_kg || "chưa rõ"} kg
- Số đo 3 vòng: Ngực ${styleProfile.chest_cm || "chưa rõ"}cm, Eo ${styleProfile.waist_cm || "chưa rõ"}cm, Mông ${styleProfile.hip_cm || "chưa rõ"}cm
- Dáng người: ${styleProfile.body_shape || "chưa rõ"}
- Tông da: ${styleProfile.skin_tone || "chưa rõ"}
- Phong cách: ${styleTags.join(", ") || "chưa rõ"}
- Dịp ưa thích: ${occasions.join(", ") || "chưa rõ"}
- Ngân sách: ${styleProfile.budget_range || "chưa rõ"}`;
  }

  const productContext = contextProducts.length
    ? `\n\nSản phẩm có sẵn trong database:\n${contextProducts.map((p) => `- ID: ${p.product_id}, Tên: ${p.name}, Giá: ${Number(p.sale_price || p.base_price).toLocaleString("vi-VN")}đ, SKU: ${p.sku}`).join("\n")}`
    : "";

  const policyInstruction = `\n\nNGUỒN CHÍNH SÁCH:
- Khi khách hỏi về chính sách, đổi trả, hoàn tiền, vận chuyển, phí ship, bảo mật, thành viên, FAQ hoặc điều khoản sử dụng, PHẢI dùng tool get_policies hoặc search_policies để lấy dữ liệu mới nhất từ database.
- Database là nguồn đúng duy nhất cho nội dung chính sách. Không trả lời theo thông tin hardcode nếu dữ liệu database khác prompt.
- Khi trả lời chính sách, hãy tóm tắt ngắn gọn, đúng mốc thời gian và số tiền trong database.`;

  const systemContent = SYSTEM_PROMPT + policyInstruction + styleContext + productContext;

  const apiMessages: JsonObject[] = [
    { role: "system", content: systemContent }
  ];

  const historyMessages = messages.filter((m) => {
    const meta = isJsonObject(m.metadata) ? m.metadata : null;
    return !meta?.system;
  });
  for (const m of historyMessages) {
    const role = m.sender === "user" ? "user" : "assistant";
    apiMessages.push({ role, content: m.text });
  }

  const MISTRAL_TOOLS = GEMINI_TOOLS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }));

  try {
    console.log("[LLM] Calling Mistral API:", config.mistralModel);

    const body = {
      model: config.mistralModel || "mistral-small-latest",
      messages: apiMessages,
      tools: MISTRAL_TOOLS,
      tool_choice: "auto"
    };

    let response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("[LLM] Mistral error:", response.status, err.substring(0, 300));
      return { text: "", productIds: [], used: false, intent: "llm_error", metadata: { error: err } };
    }

    let data: unknown = await response.json();
    const dataObj = isJsonObject(data) ? data : {};
    console.log("[LLM] Response ID:", dataObj.id);

    let choice = Array.isArray(dataObj.choices) && isJsonObject(dataObj.choices[0]) ? dataObj.choices[0] : {};
    let assistantMessage = isJsonObject(choice.message) ? choice.message : {};
    let finalText = typeof assistantMessage.content === "string" ? assistantMessage.content : "";
    const allProductIds: unknown[] = [];
    const allProductsObj: JsonObject[] = [];
    const allBlogIds: unknown[] = [];
    const usedTools: string[] = [];
    let createdTicket: JsonObject | null = null;

    const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
    if (toolCalls.length > 0) {
      console.log("[LLM] Tool calls found:", toolCalls.length);

      apiMessages.push(assistantMessage);

      for (const rawCall of toolCalls) {
        const toolCall = isJsonObject(rawCall) ? rawCall : {};
        const fn = isJsonObject(toolCall.function) ? toolCall.function : {};
        const name = asString(fn.name);
        let args: JsonObject = {};
        try {
          args = typeof fn.arguments === "string"
            ? asJsonObject(JSON.parse(fn.arguments) as unknown)
            : (isJsonObject(fn.arguments) ? fn.arguments : {});
        } catch (e: unknown) {
          console.error("[LLM] Failed to parse arguments for tool", name, e);
        }

        usedTools.push(name);
        console.log("[LLM] Tool call:", name, JSON.stringify(args));

        const toolResult = await executeToolCall(name, args, repository, userId);
        if (Array.isArray(toolResult.products)) {
          allProductIds.push(...toolResult.products.map((p) => p.product_id));
          allProductsObj.push(...toolResult.products);
        }
        if (Array.isArray(toolResult.blogs)) {
          allBlogIds.push(...toolResult.blogs.map((b) => b.blog_id));
        }
        if (name === "create_support_ticket" && isJsonObject(toolResult.ticket)) {
          createdTicket = toolResult.ticket;
        }
        apiMessages.push({
          role: "tool",
          name: name,
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult)
        });
      }

      console.log("[LLM] Calling Mistral again after tool execution...");
      response = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: config.mistralModel || "mistral-small-latest",
          messages: apiMessages
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (!response.ok) {
        const err = await response.text();
        console.error("[LLM] Mistral follow-up error:", response.status, err.substring(0, 300));
        return { text: "", productIds: [], used: false, intent: "llm_error", metadata: { error: err } };
      }

      data = await response.json();
      const followUp = isJsonObject(data) ? data : {};
      choice = Array.isArray(followUp.choices) && isJsonObject(followUp.choices[0]) ? followUp.choices[0] : {};
      const followMessage = isJsonObject(choice.message) ? choice.message : {};
      finalText = typeof followMessage.content === "string" ? followMessage.content : "";
      data = followUp;
    }

    const finalProductIds = inferProductIdsFromAnswer(finalText, contextProducts.concat(allProductsObj));
    const resultData = isJsonObject(data) ? data : {};
    console.log("[LLM] Final reply length:", finalText.length, "Products:", finalProductIds.length, "Blogs:", allBlogIds.length);
    return {
      text: finalText.trim().slice(0, 4000),
      productIds: finalProductIds.slice(0, 6),
      blogIds: [...new Set(allBlogIds)].slice(0, 6),
      used: true,
      intent: detectIntent(usedTools, messages),
      interactionId: resultData.id,
      createdTicket,
      metadata: { tools_used: usedTools, model: config.mistralModel || "mistral-large-latest" }
    };
  } catch (error: unknown) {
    console.error("[LLM] Error in callMistralChat:", errorMessage(error));
    return { text: "", productIds: [], used: false, intent: "llm_error", metadata: { error: errorMessage(error) } };
  }
}

async function executeToolCall(name: string, args: JsonObject, repository: ChatbotRepository, userId: string | null = null): Promise<JsonObject> {
  switch (name) {
    case "search_products": {
      const limit = asNumber(args.limit) || 6;
      const result = await repository.searchProducts(args.query || "", limit);
      const products = (result.rows || []).slice(0, limit);
      return {
        products,
        summary: products.length
          ? products.map((p) => `${p.name} - ${Number(p.sale_price || p.base_price).toLocaleString("vi-VN")}đ`).join("\n")
          : "Không tìm thấy sản phẩm phù hợp"
      };
    }
    case "get_categories": {
      const result = await repository.listCategories?.() || { rows: [] };
      return { categories: result.rows || [], summary: (result.rows || []).map((c) => c.name).join(", ") };
    }
    case "get_product_detail": {
      const result = await repository.getProductById?.(asString(args.product_id)) || null;
      let summaryText = "Không tìm thấy";
      if (result) {
        summaryText = `${result.name} - ${Number(result.sale_price || result.base_price).toLocaleString("vi-VN")}đ`;
        const comboComponents = Array.isArray(result.combo_components) ? result.combo_components.filter(isJsonObject) : [];
        if (result.is_combo && comboComponents.length > 0) {
          const componentsStr = comboComponents
            .map((c) => {
              const product = isJsonObject(c.product) ? c.product : {};
              return `  + ${c.quantity}x ${product.name || "Sản phẩm"} (SKU: ${product.sku || "N/A"})`;
            })
            .join("\n");
          summaryText += `\nĐây là sản phẩm COMBO bao gồm:\n${componentsStr}`;
        }
      }
      return {
        product: result,
        summary: summaryText
      };
    }
    case "get_order_status": {
      const q = String(args.order_query || "").trim();
      if (!q) return { error: "Yêu cầu mã đơn hàng hoặc số điện thoại" };

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(q);
      const filter: Record<string, unknown> = {};
      if (isUuid) {
        filter.order_id = `eq.${q}`;
      } else {
        filter.or = `(tracking_code.eq.${q},shipping_phone.eq.${q})`;
      }

      const result = await repository.searchOrders?.(filter) || { rows: [] };
      const orders = result.rows || [];
      if (!orders.length) {
        return { summary: `Không tìm thấy đơn hàng nào khớp với thông tin "${q}".` };
      }

      const details = orders.map((o) => {
        const dateStr = new Date(asString(o.order_date)).toLocaleDateString("vi-VN");
        const amountStr = Number(o.total_amount || 0).toLocaleString("vi-VN") + "đ";
        const statusMap: Record<string, string> = {
          pending: "Đang chờ xử lý",
          confirmed: "Đã xác nhận",
          preparing: "Đang chuẩn bị hàng",
          shipping: "Đang giao hàng",
          delivered: "Đã giao hàng thành công",
          failed_delivery: "Giao hàng thất bại",
          cancelled: "Đã hủy đơn",
          completed: "Đơn hàng hoàn tất"
        };
        const statusKey = asString(o.status);
        const statusText = statusMap[statusKey] || o.status;
        return `Đơn hàng ${asString(o.order_id).substring(0, 8)}... (${dateStr}): Trạng thái: ${statusText}, Tổng tiền: ${amountStr}, Mã vận đơn: ${o.tracking_code || "Chưa có"}`;
      }).join("\n");

      return { orders, summary: details };
    }
    case "update_style_profile": {
      if (!userId) {
        return { error: "Bạn cần đăng nhập dưới quyền Thành viên để lưu trữ vĩnh viễn hồ sơ phong cách này." };
      }
      const updated = await repository.updateStyleProfile(userId, args);
      return {
        profile: updated,
        summary: `Đã cập nhật hồ sơ phong cách thành công với các thông số: ${Object.entries(args).map(([k, v]) => `${k}: ${v}`).join(", ")}.`
      };
    }
    case "get_policies": {
      const result = await repository.listPolicies?.() || { rows: [] };
      const policies = result.rows || [];
      return {
        policies,
        summary: policies.length
          ? policies.map(formatPolicyForTool).join("\n\n")
          : "Chưa có dữ liệu chính sách được công bố trong database."
      };
    }
    case "search_policies": {
      const result = await repository.searchPolicies(args.query || "");
      const policies = result.rows || [];
      const formatted = policies.map((p) => {
        let contentStr = "";
        if (Array.isArray(p.content)) {
          contentStr = p.content.map((section: unknown) => {
            const block = isJsonObject(section) ? section : {};
            const heading = block.heading ? `**${block.heading}**\n` : "";
            const items = Array.isArray(block.items)
              ? block.items.map((item: unknown) => `- ${item}`).join("\n")
              : String(block.text || "");
            return heading + items;
          }).join("\n\n");
        } else {
          contentStr = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
        }
        return `=== ${p.title} ===\nTóm tắt: ${p.summary}\nChi tiết:\n${contentStr}`;
      }).join("\n\n");
      return {
        policies,
        summary: policies.length ? formatted : "Không tìm thấy chính sách tương ứng"
      };
    }
    case "search_blogs": {
      const result = await repository.searchBlogs(args.query || "");
      const blogs = result.rows || [];
      const formatted = blogs.map((b) => {
        const content = asString(b.content);
        const body = content ? content.slice(0, 1200) + (content.length > 1200 ? "..." : "") : "";
        return `=== ${b.title} ===\nTác giả: ${b.author} | Thời lượng đọc: ${b.read_minutes} phút\nTóm tắt: ${b.excerpt}\nNội dung:\n${body}`;
      }).join("\n\n");
      return {
        blogs,
        summary: blogs.length ? formatted : "Không tìm thấy bài viết blog phù hợp"
      };
    }
    case "create_support_ticket": {
      const ticket = await repository.createSupportTicket({
        profileUserId: userId || null,
        guestEmail: asString(args.email) || null,
        guestPhone: asString(args.phone) || null,
        title: asString(args.title),
        description: asString(args.description),
        priority: "high"
      });
      return {
        ticket,
        summary: `Tạo ticket thành công. Mã ticket hỗ trợ của bạn là: ${ticket.ticket_id}. CSKH của Velura đã được thông báo và sẽ phản hồi trong thời gian sớm nhất.`
      };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function formatPolicyForTool(policy: JsonObject): string {
  const sections = Array.isArray(policy.content)
    ? policy.content.map((section) => {
      const block = isJsonObject(section) ? section : {};
      const heading = block.heading ? `**${block.heading}**\n` : "";
      const body = Array.isArray(block.items)
        ? block.items.map((item: unknown) => `- ${item}`).join("\n")
        : String(block.text || "");
      return `${heading}${body}`.trim();
    }).filter(Boolean).join("\n")
    : typeof policy.content === "string"
      ? policy.content
      : JSON.stringify(policy.content || {});
  return `=== ${policy.title} ===\nTóm tắt: ${policy.summary || ""}\nChi tiết:\n${sections}`;
}

function detectIntent(tools: string[], messages: JsonObject[]): string {
  const lastRaw = messages[messages.length - 1]?.text;
  const last = typeof lastRaw === "string" ? lastRaw.toLowerCase() : "";
  if (tools.includes("get_order_status")) return "order_query";
  if (tools.includes("search_products")) return "product_search";
  if (tools.includes("get_categories")) return "category_browse";
  if (tools.includes("get_policies") || tools.includes("search_policies")) return "policy_query";
  if (tools.includes("get_product_detail")) return "product_detail";
  if (tools.includes("update_style_profile")) return "style_update";
  if (tools.includes("create_support_ticket")) return "ticket_creation";
  if (/(đơn hàng|order|tracking)/.test(last)) return "order_query";
  if (/(size|kích cỡ)/.test(last)) return "size_query";
  if (/(chính sách|đổi trả|bảo hành)/.test(last)) return "policy_query";
  return "general";
}
