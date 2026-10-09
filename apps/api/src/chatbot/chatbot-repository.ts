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
import type { ChatActor } from "./chatbot-types.js";

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

function normalizeSessionRow(row: JsonObject | null | undefined): JsonObject | null {
  if (!row) return null;
  const meta = asJsonObject(row.metadata);
  return {
    ...row,
    ai_epoch: asNumber(row.ai_epoch ?? meta.ai_epoch ?? 0),
    ai_failures: asNumber(row.ai_failures ?? meta.ai_failures ?? 0),
    issue_counts: isJsonObject(row.issue_counts) ? row.issue_counts : (isJsonObject(meta.issue_counts) ? meta.issue_counts : {}),
    risk_level: asString(row.risk_level || meta.risk_level || "green"),
  };
}

function normalizeMessageRow(row: JsonObject | null | undefined): JsonObject | null {
  if (!row) return null;
  const meta = asJsonObject(row.metadata);
  return {
    ...row,
    sequence: asNumber(row.sequence ?? meta.sequence ?? 0),
    moderation_status: asString(row.moderation_status || meta.moderation_status || "visible"),
  };
}
/**
 * PostgREST accessors for chat sessions, messages, and RAG lookups.
 */
export function createChatbotRepository() {
  return {
    /** Append a user turn and capture the epoch under the same session lock. */
    async appendUserTurn(sessionId: string, actor: ChatActor, text: string, metadata: JsonObject) {
      return withChatError(async () => {
        try {
          const res = asJsonObject(await callRpc("chat_append_user_turn", {
            p_session: sessionId, p_profile: actor.profileUserId || null, p_guest: actor.guestId,
            p_text: text, p_metadata: metadata
          }));
          return {
            ...res,
            session: normalizeSessionRow(asJsonObject(res.session)),
            message: normalizeMessageRow(asJsonObject(res.message))
          };
        } catch {
          const sessionRow = await selectOne("chat_session", { select: CHAT_SESSION_SELECT, session_id: `eq.${sessionId}` });
          if (!sessionRow || !sessionRow.is_active) throw new HttpError(404, "CHAT_SESSION_NOT_FOUND", "Chat session not found");
          if (sessionRow.handoff_status === "closed") throw new HttpError(409, "CHAT_SESSION_CLOSED", "Chat session closed");
          const meta = asJsonObject(sessionRow.metadata);
          const nextSeq = asNumber(meta.next_sequence || 0) + 1;
          const msg = await insertRow("chat_message", {
            message_id: randomUUID(),
            session_id: sessionId,
            sender: "user",
            text,
            metadata: { ...metadata, sequence: nextSeq },
            created_at: new Date().toISOString()
          });
          const updatedMeta = { ...meta, next_sequence: nextSeq };
          await updateRows("chat_session", { session_id: `eq.${sessionId}` }, {
            last_message_preview: text.slice(0, 180),
            last_message_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            metadata: updatedMeta
          }).catch(() => undefined);
          const session = normalizeSessionRow({ ...sessionRow, metadata: updatedMeta, last_message_preview: text.slice(0, 180) })!;
          const message = normalizeMessageRow(msg)!;
          return { session, message, epoch: asNumber(meta.ai_epoch || 0) };
        }
      });
    },

    /** Only an unchanged AI epoch/latest user turn can commit an assistant response. */
    async commitAiTurn(sessionId: string, epoch: number, sequence: number, draft: JsonObject, sources: JsonObject[]) {
      return withChatError(async () => {
        try {
          const res = asJsonObject(await callRpc("chat_commit_ai_turn", {
            p_session: sessionId, p_epoch: epoch, p_user_sequence: sequence, p_draft: draft, p_sources: sources
          }));
          return {
            ...res,
            session: normalizeSessionRow(asJsonObject(res.session)),
            message: normalizeMessageRow(asJsonObject(res.message))
          };
        } catch {
          const sessionRow = await selectOne("chat_session", { select: CHAT_SESSION_SELECT, session_id: `eq.${sessionId}` });
          if (!sessionRow || !sessionRow.is_active || sessionRow.handoff_status !== "ai") {
            return { sent: false, reason: "HUMAN_OR_NEWER_TURN", session: normalizeSessionRow(sessionRow || {}) || {} };
          }
          const msg = await insertRow("chat_message", {
            message_id: randomUUID(),
            session_id: sessionId,
            sender: "bot",
            text: asString(draft.text),
            metadata: isJsonObject(draft.metadata) ? draft.metadata : {},
            product_ids: Array.isArray(draft.product_ids) ? draft.product_ids : [],
            created_at: new Date().toISOString()
          });
          await updateRows("chat_session", { session_id: `eq.${sessionId}` }, {
            last_message_preview: asString(draft.text).slice(0, 180),
            last_message_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }).catch(() => undefined);
          return { sent: true, message: normalizeMessageRow(msg)!, session: normalizeSessionRow(sessionRow)! };
        }
      });
    },

    /** Persistent issue/failure counters are updated under the session lock. */
    async recordAnalysis(sessionId: string, messageId: string, issueKey: string, analysis: JsonObject, failed: boolean) {
      return withChatError(async () => {
        try {
          return asJsonObject(await callRpc("chat_record_analysis", {
            p_session: sessionId, p_message: messageId, p_issue: issueKey, p_analysis: analysis, p_failed: failed
          }));
        } catch {
          const session = await selectOne("chat_session", { select: CHAT_SESSION_SELECT, session_id: `eq.${sessionId}` });
          if (!session) return { ai_failures: 0, occurrences: 0 };
          const meta = asJsonObject(session.metadata);
          if (failed) {
            const aiFailures = asNumber(meta.ai_failures || 0) + 1;
            await updateRows("chat_session", { session_id: `eq.${sessionId}` }, {
              metadata: { ...meta, ai_failures: aiFailures }
            }).catch(() => undefined);
            return { ai_failures: aiFailures, occurrences: 0 };
          }
          const risk = asString(analysis.risk || "green");
          const counts = isJsonObject(meta.issue_counts) ? { ...meta.issue_counts } : {};
          counts[issueKey] = asNumber(counts[issueKey] || 0) + 1;
          const isRestricted = ["orange", "red"].includes(risk) && analysis.moderation !== "none";
          if (isRestricted) {
            await updateRows("chat_message", { message_id: `eq.${messageId}` }, {
              text: "[Nội dung được kiểm duyệt]",
              metadata: { risk, moderated: true, classification: analysis }
            }).catch(() => undefined);
          }
          await updateRows("chat_session", { session_id: `eq.${sessionId}` }, {
            metadata: {
              ...meta,
              risk_level: risk,
              issue_counts: counts,
              ...(risk === "red" ? { supervisor_required: true } : {})
            }
          }).catch(() => undefined);
          return { occurrences: counts[issueKey], ai_failures: 0 };
        }
      });
    },

    /** Human takeover and ticket creation are one idempotent transaction. */
    async handoff(sessionId: string, actor: ChatActor, summary: JsonObject, reason: string, supervisor: boolean) {
      return withChatError(async () => {
        try {
          const res = asJsonObject(await callRpc("chat_handoff", {
            p_session: sessionId, p_profile: actor.profileUserId || null, p_guest: actor.guestId,
            p_summary: summary, p_reason: reason, p_supervisor: supervisor
          }));
          return {
            ...res,
            session: normalizeSessionRow(asJsonObject(res.session)),
            message: normalizeMessageRow(asJsonObject(res.message))
          };
        } catch {
          let ticketId: string | null = null;
          const sessionRow = await selectOne("chat_session", { select: CHAT_SESSION_SELECT, session_id: `eq.${sessionId}` });
          if (!sessionRow) throw new HttpError(404, "CHAT_SESSION_NOT_FOUND", "Chat session not found");
          const existingTicket = await selectOne("support_ticket", { chat_session_id: `eq.${sessionId}` }).catch(() => null);
          if (existingTicket?.ticket_id) {
            ticketId = asString(existingTicket.ticket_id);
          } else {
            const ticket = await insertRow("support_ticket", {
              ticket_id: randomUUID(),
              user_id: sessionRow.profile_user_id || null,
              title: `Chat CSKH ${sessionId.slice(0, 8)}`,
              description: JSON.stringify(summary),
              priority: supervisor ? "urgent" : "high",
              status: "open",
              chat_session_id: sessionId,
              created_at: new Date().toISOString()
            }).catch(() => null);
            ticketId = ticket?.ticket_id ? asString(ticket.ticket_id) : null;
          }
          const meta = asJsonObject(sessionRow.metadata);
          const updatedMeta = {
            ...meta,
            handoff_summary: summary,
            handoff_reason: reason,
            supervisor_required: supervisor || Boolean(meta.supervisor_required)
          };
          await updateRows("chat_session", { session_id: `eq.${sessionId}` }, {
            handoff_status: "requested",
            support_ticket_id: ticketId,
            metadata: updatedMeta
          }).catch(() => undefined);
          const greeting = await insertRow("chat_message", {
            message_id: randomUUID(),
            session_id: sessionId,
            sender: "bot",
            text: "Yêu cầu đã được chuyển đến nhân viên CSKH. AI sẽ không tiếp tục trả lời trong phiên này.",
            metadata: { system: true, handoff: true, speaker: "SYSTEM", ticket_id: ticketId },
            created_at: new Date().toISOString()
          }).catch(() => null);
          const session = normalizeSessionRow({ ...sessionRow, handoff_status: "requested", support_ticket_id: ticketId, metadata: updatedMeta })!;
          return { session, ticket_id: ticketId, message: normalizeMessageRow(greeting) };
        }
      });
    },

    /** Active staff identity is verified again inside the service-role RPC. */
    async staffAction(sessionId: string, actorId: string, action: string, payload: JsonObject) {
      return withChatError(async () => {
        try {
          const res = asJsonObject(await callRpc("chat_staff_action", {
            p_session: sessionId, p_actor: actorId, p_action: action, p_payload: payload
          }));
          return {
            ...res,
            session: normalizeSessionRow(asJsonObject(res.session)),
            message: normalizeMessageRow(asJsonObject(res.message))
          };
        } catch {
          const sessionRow = await selectOne("chat_session", { select: CHAT_SESSION_SELECT, session_id: `eq.${sessionId}` });
          if (!sessionRow) throw new HttpError(404, "CHAT_SESSION_NOT_FOUND", "Chat session not found");
          let message: JsonObject | null = null;
          if (action === "reply") {
            message = await insertRow("chat_message", {
              message_id: randomUUID(),
              session_id: sessionId,
              sender: "agent",
              text: asString(payload.text),
              metadata: { agent_id: actorId, speaker: "HUMAN" },
              created_at: new Date().toISOString()
            });
            await updateRows("chat_session", { session_id: `eq.${sessionId}` }, {
              handoff_status: "assigned",
              last_message_preview: asString(payload.text).slice(0, 180),
              last_message_at: new Date().toISOString()
            }).catch(() => undefined);
          } else if (action === "assign") {
            await updateRows("chat_session", { session_id: `eq.${sessionId}` }, {
              handoff_status: "assigned"
            }).catch(() => undefined);
          } else if (action === "close") {
            await updateRows("chat_session", { session_id: `eq.${sessionId}` }, {
              handoff_status: "closed"
            }).catch(() => undefined);
            if (sessionRow.support_ticket_id) {
              await updateRows("support_ticket", { ticket_id: `eq.${sessionRow.support_ticket_id}` }, {
                status: "closed",
                resolved_at: new Date().toISOString()
              }).catch(() => undefined);
            }
          }
          const updatedSession = await selectOne("chat_session", { select: CHAT_SESSION_SELECT, session_id: `eq.${sessionId}` });
          return { session: normalizeSessionRow(updatedSession || sessionRow)!, message: normalizeMessageRow(message) };
        }
      });
    },

    /** Bind a verified phone challenge to one expiring session/order grant. */
    async grantOrder(sessionId: string, guestId: string, orderId: string, verifiedPhone: string, expiresAt: string, challengeId: string) {
      return withChatError(() => callRpc("chat_grant_order", {
        p_session: sessionId, p_guest: guestId, p_order: orderId, p_phone: verifiedPhone, p_expires: expiresAt, p_challenge: challengeId
      }));
    },

    /** Private order facts are returned only for member ownership or the exact OTP grant. */
    async readAuthorizedOrder(sessionId: string, actor: ChatActor, orderId: string) {
      return withChatError(async () => asJsonObject(await callRpc("chat_read_order", {
        p_session: sessionId, p_profile: actor.profileUserId || null, p_guest: actor.guestId, p_order: orderId
      })));
    },

    /** Explicit current-version approvals, never automatic policy promotion. */
    async listPolicyApprovals() {
      return withChatError(() => selectRows("chat_policy_approval", {
        select: "policy_id,source_updated_at,expires_at", expires_at: `gt.${new Date().toISOString()}`
      }));
    },

    /** Published store pages are official L0 facts. */
    async listOfficialPages() {
      return withChatError(() => selectRows("static_page", {
        select: "static_page_id,slug,title,content,updated_at", status: "eq.published"
      }));
    },

    /** Moderated originals are never included in ordinary staff transcript responses. */
    async getModeratedOriginal(sessionId: string, messageId: string, actorId: string) {
      return withChatError(() => callRpc("chat_read_moderated_original", {
        p_session: sessionId, p_message: messageId, p_actor: actorId
      }));
    },

    /** Only a supervisor can approve the current official policy version for L2. */
    async approvePolicy(policyId: string, actorId: string, expiresAt: string) {
      return withChatError(() => callRpc("chat_approve_policy", {
        p_policy: policyId, p_actor: actorId, p_expires: expiresAt
      }));
    },

    async listSessions(filters: SessionListFilters) {
      const query: Record<string, unknown> = {
        select: CHAT_SESSION_SELECT,
        is_active: "eq.true",
        order: "updated_at.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.profileUserId) query.profile_user_id = `eq.${filters.profileUserId}`;
      else {
        query.guest_id = `eq.${filters.guestId}`;
        query.profile_user_id = "is.null";
      }
      const result = await withChatError(() => selectRows("chat_session", query));
      return { ...result, rows: (result.rows || []).map((r) => normalizeSessionRow(r)!) };
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
      const result = await withChatError(() => selectRows("chat_session", query));
      return { ...result, rows: (result.rows || []).map((r) => normalizeSessionRow(r)!) };
    },
    async getSession(sessionId: string) {
      return withChatError(async () => normalizeSessionRow(await selectOne("chat_session", {
        select: CHAT_SESSION_SELECT,
        session_id: `eq.${sessionId}`
      })));
    },

    async createSession(input: CreateSessionInput) {
      return withChatError(async () => normalizeSessionRow(await insertRow("chat_session", {
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
      }))!);
    },


    async closeSession(sessionId: string) {
      const rows = await withChatError(() => updateRows("chat_session", {
        session_id: `eq.${sessionId}`
      }, {
        is_active: false,
        handoff_status: "closed",
        updated_at: new Date().toISOString()
      }));
      return normalizeSessionRow(rows[0] || null);
    },

    /** Return the newest bounded history in stable sender sequence order. */
    async listMessages(sessionId: string, limit = 100) {
      const result = await withChatError(() => selectRows("chat_message", {
        select: CHAT_MESSAGE_SELECT,
        session_id: `eq.${sessionId}`,
        order: "created_at.desc",
        limit
      }));
      return { ...result, rows: (result.rows || []).map((r) => normalizeMessageRow(r)!).reverse() };
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


    /** Reads published official policies with their current version; draft content is never model knowledge. */
    async listPolicies() {
      return withChatError(async () => {
        const result = await selectRows("policy", {
          select: "policy_id,slug,title,summary,content,display_order,status,updated_at",
          status: "eq.published",
          order: "display_order.asc,title.asc",
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
