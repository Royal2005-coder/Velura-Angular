import { randomUUID } from "node:crypto";
import { HttpError } from "../http.js";
import {
  callRpc as supabaseCallRpc,
  insertRow as supabaseInsertRow,
  selectOne as supabaseSelectOne,
  selectRows as supabaseSelectRows,
  updateRows as supabaseUpdateRows
} from "../supabase.js";
import { generateGeminiEmbedding, isGeminiConfigured, vectorLiteral } from "../gemini-client.js";
import { asJsonObject, asNumber, asString, errorMessage, isJsonObject, type JsonObject } from "../types.js";
import { CHAT_MESSAGE_SELECT, CHAT_PRODUCT_SELECT, CHAT_SESSION_SELECT } from "./chatbot-constants.js";

const CHAT_DB_OPTIONS = Object.freeze({ useAnonKey: false });

interface SessionListFilters {
  profileUserId?: string;
  guestId?: string | null;
  limit: number;
  offset: number;
}

interface AdminSessionListFilters {
  handoffOnly?: boolean;
  handoffStatus?: string;
  ticketId?: string;
  limit: number;
  offset: number;
}

interface CreateSessionInput {
  authUserId?: string;
  profileUserId?: string;
  guestId?: string | null;
  title: string;
  lastMessagePreview?: string | null;
  metadata?: JsonObject;
}

interface InsertMessageInput {
  sessionId: string;
  sender: string;
  text: string;
  metadata?: JsonObject;
  productIds?: unknown[];
}

interface InsertAiLogInput {
  profileUserId?: string | null;
  messages?: unknown;
  recommendedProducts?: unknown;
  quizResults?: unknown;
  escalatedToHuman?: boolean;
}

interface CreateSupportTicketInput {
  profileUserId?: string | null;
  guestPhone?: string | null;
  guestEmail?: string | null;
  title: string;
  description: string;
  priority?: string;
  aiLogId?: unknown;
}

interface QueueEmailInput {
  recipient?: string | null;
  templateCode: string;
  subject: string;
  body: string;
  relatedUserId?: string | null;
  metadata?: JsonObject;
}

function selectRows(table: string, query: Record<string, unknown>) {
  return supabaseSelectRows(table, query, CHAT_DB_OPTIONS);
}

function selectOne(table: string, query: Record<string, unknown>) {
  return supabaseSelectOne(table, query, CHAT_DB_OPTIONS);
}

async function insertRow(table: string, payload: unknown): Promise<JsonObject> {
  const row = await supabaseInsertRow(table, payload, CHAT_DB_OPTIONS);
  return isJsonObject(row) ? row : asJsonObject(row);
}

async function updateRows(table: string, query: Record<string, unknown>, payload: unknown): Promise<JsonObject[]> {
  const rows = await supabaseUpdateRows(table, query, payload, CHAT_DB_OPTIONS);
  return rows.filter(isJsonObject);
}

function callRpc(name: string, payload: unknown) {
  return supabaseCallRpc(name, payload, CHAT_DB_OPTIONS);
}

function rpcRows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

async function getEmbedding(text: string): Promise<string | null> {
  if (!isGeminiConfigured()) return null;
  try {
    const values = await generateGeminiEmbedding(text);
    return vectorLiteral(values);
  } catch (err: unknown) {
    console.warn("[EMBEDDING_ERROR] Chatbot embedding failed, falling back to text search:", errorMessage(err) || err);
    return null;
  }
}

/**
 * PostgREST accessors for chat sessions, messages, and RAG lookups.
 */
export function createChatbotRepository() {
  return {
    async listSessions(filters: SessionListFilters) {
      const query: Record<string, unknown> = {
        select: CHAT_SESSION_SELECT,
        is_active: "eq.true",
        order: "updated_at.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.profileUserId) query.profile_user_id = `eq.${filters.profileUserId}`;
      else query.guest_id = `eq.${filters.guestId}`;
      return withChatError(() => selectRows("chat_session", query));
    },

    async listAdminSessions(filters: AdminSessionListFilters) {
      const query: Record<string, unknown> = {
        select: CHAT_SESSION_SELECT,
        order: "updated_at.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.handoffStatus) {
        query.handoff_status = `eq.${filters.handoffStatus}`;
      } else if (filters.handoffOnly) {
        query.handoff_status = "in.(requested,assigned)";
      }
      if (filters.ticketId) query.support_ticket_id = `eq.${filters.ticketId}`;
      return withChatError(() => selectRows("chat_session", query));
    },

    async getSession(sessionId: string) {
      return withChatError(() => selectOne("chat_session", {
        select: CHAT_SESSION_SELECT,
        session_id: `eq.${sessionId}`
      }));
    },

    async createSession(input: CreateSessionInput) {
      return withChatError(() => insertRow("chat_session", {
        session_id: randomUUID(),
        user_id: input.authUserId || null,
        profile_user_id: input.profileUserId || null,
        guest_id: input.guestId || null,
        title: input.title,
        source: "chatbot",
        is_active: true,
        handoff_status: "ai",
        last_message_preview: input.lastMessagePreview || null,
        last_message_at: new Date().toISOString(),
        metadata: input.metadata || {}
      }));
    },

    async updateSession(sessionId: string, patch: JsonObject) {
      const rows = await withChatError(() => updateRows("chat_session", {
        session_id: `eq.${sessionId}`
      }, {
        ...patch,
        updated_at: new Date().toISOString()
      }));
      return rows[0] || null;
    },

    async closeSession(sessionId: string) {
      const rows = await withChatError(() => updateRows("chat_session", {
        session_id: `eq.${sessionId}`
      }, {
        is_active: false,
        handoff_status: "closed",
        updated_at: new Date().toISOString()
      }));
      return rows[0] || null;
    },

    async listMessages(sessionId: string, limit = 100) {
      return withChatError(() => selectRows("chat_message", {
        select: CHAT_MESSAGE_SELECT,
        session_id: `eq.${sessionId}`,
        order: "created_at.asc",
        limit
      }));
    },

    async insertMessage(input: InsertMessageInput) {
      return withChatError(() => insertRow("chat_message", {
        message_id: randomUUID(),
        session_id: input.sessionId,
        sender: input.sender,
        text: input.text,
        metadata: input.metadata || {},
        product_ids: input.productIds || [],
        created_at: new Date().toISOString()
      }));
    },

    async searchProducts(query: unknown, limit = 6) {
      const rawValue = String(query || "").trim();
      if (!rawValue) {
        return withChatError(() => selectRows("product", {
          select: CHAT_PRODUCT_SELECT,
          status: "eq.on_sale",
          order: "is_featured.desc,updated_at.desc",
          limit
        }));
      }

      try {
        const embedding = await getEmbedding(rawValue);
        if (embedding) {
          console.log("[RAG-VECTOR] Searching products by embedding similarity...");
          const matchRows = rpcRows(await callRpc("match_products", {
            query_embedding: embedding,
            match_threshold: 0.15,
            match_count: limit,
            filter_size: null
          }));
          if (matchRows.length > 0) {
            return { rows: matchRows };
          }
        }
      } catch (err: unknown) {
        console.warn("[RAG-VECTOR] Product embedding search failed, falling back to text search:", errorMessage(err));
      }

      const value = sanitizeSearch(rawValue);
      const request: Record<string, unknown> = {
        select: CHAT_PRODUCT_SELECT,
        status: "eq.on_sale",
        order: "is_featured.desc,updated_at.desc",
        limit
      };

      request.or = `(name.ilike.*${value}*,sku.ilike.*${value}*,description.ilike.*${value}*)`;
      const res = await withChatError(() => selectRows("product", request));
      if (res.rows && res.rows.length > 0) {
        return res;
      }

      const words = value.split(" ")
        .map((w) => w.trim())
        .filter((w) => w.length > 1 && !["cho", "toi", "tôi", "mot", "một", "cai", "cái", "mau", "màu", "cua", "của", "nay", "này", "chiec", "chiếc", "voi", "với", "ban", "bạn"].includes(w.toLowerCase()));

      if (words.length > 0) {
        const allProducts: JsonObject[] = [];
        const seenIds = new Set<unknown>();

        for (const word of words.slice(0, 4)) {
          const wordReq: Record<string, unknown> = {
            select: CHAT_PRODUCT_SELECT,
            status: "eq.on_sale",
            or: `(name.ilike.*${word}*,sku.ilike.*${word}*,description.ilike.*${word}*)`,
            limit: limit * 2
          };
          const wordRes = await withChatError(() => selectRows("product", wordReq));
          for (const p of wordRes.rows || []) {
            if (!seenIds.has(p.product_id)) {
              seenIds.add(p.product_id);
              p._matchScore = 1;
              allProducts.push(p);
            } else {
              const existing = allProducts.find((x) => x.product_id === p.product_id);
              if (existing) existing._matchScore = asNumber(existing._matchScore) + 1;
            }
          }
        }

        allProducts.sort((a, b) => {
          const bScore = asNumber(b._matchScore);
          const aScore = asNumber(a._matchScore);
          if (bScore !== aScore) {
            return bScore - aScore;
          }
          const aFeatured = a.is_featured ? 1 : 0;
          const bFeatured = b.is_featured ? 1 : 0;
          if (bFeatured !== aFeatured) {
            return bFeatured - aFeatured;
          }
          return new Date(asString(b.updated_at)).getTime() - new Date(asString(a.updated_at)).getTime();
        });

        return { rows: allProducts.slice(0, limit) };
      }

      return res;
    },

    async listProductsByIds(productIds: unknown) {
      const ids = uniqueUuidList(productIds);
      if (!ids.length) return { rows: [], count: 0 };
      return withChatError(() => selectRows("product", {
        select: CHAT_PRODUCT_SELECT,
        product_id: `in.(${ids.join(",")})`,
        status: "eq.on_sale",
        limit: Math.min(ids.length, 12)
      }));
    },

    async listCategories() {
      return withChatError(() => selectRows("category", {
        select: "category_id,name,slug",
        order: "name.asc",
        limit: 50
      }));
    },

    async listPolicies() {
      return withChatError(async () => {
        const result = await selectRows("policy", {
          select: "policy_id,slug,title,summary,content,display_order,status,updated_at",
          status: "eq.published",
          order: "display_order.asc,title.asc",
          limit: 20
        });

        return {
          rows: (result.rows || []).map((row) => ({
            policy_id: row.policy_id,
            slug: row.slug,
            title: row.title,
            summary: row.summary || "",
            content: normalizePolicyContent(row.content),
            display_order: row.display_order,
            updated_at: row.updated_at
          })),
          count: result.count
        };
      });
    },

    async getProductById(productId: string) {
      const result = await withChatError(() => selectRows("product", {
        select: CHAT_PRODUCT_SELECT,
        product_id: `eq.${productId}`,
        limit: 1
      }));
      const product = result.rows?.[0] || null;
      if (product && product.is_combo) {
        try {
          const { rows: comboItems } = await selectRows("combo_item", {
            select: "combo_item_id,combo_product_id,component_product_id,component_variant_id,quantity",
            combo_product_id: `eq.${productId}`
          });
          if (comboItems && comboItems.length > 0) {
            const compIds = comboItems.map((ci) => ci.component_product_id).filter(Boolean);
            if (compIds.length > 0) {
              const compProducts = await selectRows("product", {
                select: "product_id,name,sku,base_price,sale_price",
                product_id: `in.(${compIds.join(",")})`
              });
              const compMap = new Map((compProducts.rows || []).map((p) => [p.product_id, p]));
              product.combo_components = comboItems.map((ci) => ({
                ...ci,
                product: compMap.get(ci.component_product_id) || null
              }));
            } else {
              product.combo_components = [];
            }
          } else {
            product.combo_components = [];
          }
        } catch (err: unknown) {
          console.warn("[COMBO-DETAILS] Failed to fetch combo components:", errorMessage(err));
          product.combo_components = [];
        }
      }
      return product;
    },

    async searchOrders(filter: Record<string, unknown>) {
      return withChatError(() => selectRows("orders", {
        select: "order_id,order_date,status,shipping_name,shipping_phone,total_amount,tracking_code",
        limit: 5,
        ...filter
      }));
    },

    async getStyleProfile(userId: string | null | undefined) {
      if (!userId) return null;
      return withChatError(() => selectOne("style_profile", {
        user_id: `eq.${userId}`
      }));
    },

    async updateStyleProfile(userId: string | null | undefined, patch: JsonObject) {
      if (!userId) return null;
      const rows = await withChatError(() => updateRows("style_profile", {
        user_id: `eq.${userId}`
      }, {
        ...patch,
        updated_at: new Date().toISOString()
      }));
      return rows[0] || null;
    },

    async insertAiLog(input: InsertAiLogInput) {
      return withChatError(() => insertRow("ai_log", {
        log_type: "chatbot_session",
        user_id: input.profileUserId || null,
        session_id: null,
        messages: input.messages || [],
        recommended_products: input.recommendedProducts || [],
        clicked_products: null,
        purchased_products: null,
        ctr: null,
        quiz_results: input.quizResults || null,
        escalated_to_human: Boolean(input.escalatedToHuman),
        created_at: new Date().toISOString()
      }));
    },

    async createSupportTicket(input: CreateSupportTicketInput) {
      return withChatError(() => insertRow("support_ticket", {
        ticket_id: randomUUID(),
        user_id: input.profileUserId || null,
        guest_phone: input.guestPhone || null,
        guest_email: input.guestEmail || null,
        title: input.title,
        description: input.description,
        priority: input.priority || "high",
        status: "open",
        admin_reply: null,
        ai_log_id: input.aiLogId || null,
        created_at: new Date().toISOString()
      }));
    },

    async updateSupportTicket(ticketId: unknown, patch: JsonObject) {
      if (!ticketId) return null;
      const rows = await withChatError(() => updateRows("support_ticket", {
        ticket_id: `eq.${ticketId}`
      }, {
        ...patch,
        updated_at: new Date().toISOString()
      }));
      return rows[0] || null;
    },

    async queueEmail(input: QueueEmailInput) {
      if (!input.recipient) return null;
      return withChatError(() => insertRow("email_outbox", {
        recipient: input.recipient,
        template_code: input.templateCode,
        subject: input.subject,
        body: input.body,
        related_user_id: input.relatedUserId || null,
        metadata: input.metadata || {}
      }));
    },

    async searchPolicies(query: unknown) {
      const rawValue = String(query || "").trim();
      if (!rawValue) {
        return withChatError(() => selectRows("policy", {
          select: "policy_id,slug,title,summary,content",
          limit: 6
        }));
      }

      try {
        const embedding = await getEmbedding(rawValue);
        if (embedding) {
          console.log("[RAG-VECTOR] Searching policies by embedding similarity...");
          const matchRows = rpcRows(await callRpc("match_policies", {
            query_embedding: embedding,
            match_threshold: 0.15,
            match_count: 5
          }));
          if (matchRows.length > 0) {
            return { rows: matchRows };
          }
        }
      } catch (err: unknown) {
        console.warn("[RAG-VECTOR] Policy embedding search failed, falling back to text search:", errorMessage(err));
      }

      const value = sanitizeSearch(rawValue);
      return withChatError(() => selectRows("policy", {
        select: "policy_id,slug,title,summary,content",
        or: `(title.ilike.*${value}*,summary.ilike.*${value}*)`,
        limit: 5
      }));
    },

    async searchBlogs(query: unknown) {
      const rawValue = String(query || "").trim();
      if (!rawValue) {
        return withChatError(() => selectRows("blog", {
          select: "blog_id,slug,title,excerpt,content,image_url,author,read_minutes",
          status: "eq.published",
          limit: 6
        }));
      }

      try {
        const embedding = await getEmbedding(rawValue);
        if (embedding) {
          console.log("[RAG-VECTOR] Searching blogs by embedding similarity...");
          const matchRows = rpcRows(await callRpc("match_blogs", {
            query_embedding: embedding,
            match_threshold: 0.15,
            match_count: 5
          }));
          if (matchRows.length > 0) {
            return { rows: matchRows };
          }
        }
      } catch (err: unknown) {
        console.warn("[RAG-VECTOR] Blog embedding search failed, falling back to text search:", errorMessage(err));
      }

      const value = sanitizeSearch(rawValue);
      return withChatError(() => selectRows("blog", {
        select: "blog_id,slug,title,excerpt,content,image_url,author,read_minutes",
        status: "eq.published",
        or: `(title.ilike.*${value}*,excerpt.ilike.*${value}*,content.ilike.*${value}*)`,
        limit: 5
      }));
    },

    async listBlogsByIds(blogIds: unknown) {
      const ids = uniqueUuidList(blogIds);
      if (!ids.length) return { rows: [], count: 0 };
      return withChatError(() => selectRows("blog", {
        select: "blog_id,slug,title,excerpt,content,image_url,author,read_minutes",
        blog_id: `in.(${ids.join(",")})`,
        status: "eq.published",
        limit: Math.min(ids.length, 12)
      }));
    }
  };
}

/**
 * Repository returned by `createChatbotRepository`.
 */
export type ChatbotRepository = ReturnType<typeof createChatbotRepository>;

function sanitizeSearch(value: unknown): string {
  return String(value || "")
    .replace(/[%,*()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function uniqueUuidList(values: unknown): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = String(value || "").trim();
    if (!isUuid(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizePolicyContent(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function withChatError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof HttpError && error.code === "SERVICE_ROLE_REQUIRED") {
      throw new HttpError(
        503,
        "CHAT_SERVICE_UNAVAILABLE",
        "Chat service database credentials are not configured"
      );
    }
    if (error instanceof HttpError && error.code === "SUPABASE_ERROR") {
      const details = asJsonObject(error.details);
      const databaseCode = asString(details.message) || asString(details.code) || "CHATBOT_DATABASE_ERROR";
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      throw new HttpError(status, databaseCode, chatbotErrorMessage(databaseCode), error.details);
    }
    throw error;
  }
}

function chatbotErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    INVALID_TEXT_REPRESENTATION: "Invalid chat identifier",
    CHATBOT_DATABASE_ERROR: "Chat database operation failed"
  };
  return messages[code] || "Chat database operation failed";
}
