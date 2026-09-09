import { config } from "../config.js";
import { analyzeImageWithGemini } from "../gemini-client.js";
import { HttpError } from "../http.js";
import { CHAT_SUPPORT_ROLES, DEFAULT_ASSISTANT_GREETING, HANDOFF_REPLY } from "./chatbot-constants.js";
import { createLLMService } from "./llm-service.js";

console.log("[CHATBOT-INIT] config.geminiApiKey:", config.geminiApiKey ? "SET" : "EMPTY");
console.log("[CHATBOT-INIT] config.geminiModel:", config.geminiModel);

export function createChatbotService({ repository }) {
  if (!repository) throw new TypeError("repository is required");

  const llm = createLLMService({ repository });

  return {
    async listSessions(context, searchParams) {
      const actor = resolveChatActor(context, {
        guestId: searchParams.get("guestId") || searchParams.get("guest_id")
      });
      return repository.listSessions({
        profileUserId: actor.profileUserId,
        guestId: actor.guestId,
        limit: boundedInteger(searchParams.get("limit"), 30, 1, 100),
        offset: boundedInteger(searchParams.get("offset"), 0, 0, 100000)
      });
    },

    async createSession(context, body) {
      const actor = resolveChatActor(context, body);
      const title = buildSessionTitle(body?.title || body?.message || "Tư vấn Velura");
      const session = await repository.createSession({
        authUserId: actor.authUserId,
        profileUserId: actor.profileUserId,
        guestId: actor.guestId,
        title,
        lastMessagePreview: DEFAULT_ASSISTANT_GREETING,
        metadata: {
          channel: "web",
          guest_email: cleanEmail(body?.guestEmail),
          guest_phone: cleanPhone(body?.guestPhone)
        }
      });
      const greeting = await repository.insertMessage({
        sessionId: session.session_id,
        sender: "bot",
        text: DEFAULT_ASSISTANT_GREETING,
        metadata: { system: true },
        productIds: []
      });
      return { session, messages: [greeting], products: [], blogs: [] };
    },

    async getMessages(context, sessionId, searchParams) {
      requireUuid(sessionId, "sessionId");
      const actor = resolveChatActor(context, {
        guestId: searchParams.get("guestId") || searchParams.get("guest_id")
      });
      const session = await requireOwnedSession(repository, sessionId, actor);
      const messages = await repository.listMessages(session.session_id, boundedInteger(searchParams.get("limit"), 100, 1, 300));
      const products = await hydrateProductsForMessages(repository, messages.rows || []);
      const blogs = await hydrateBlogsForMessages(repository, messages.rows || []);
      return { session, messages: messages.rows || [], products, blogs };
    },

    async deleteSession(context, sessionId, body = {}) {
      requireUuid(sessionId, "sessionId");
      const actor = resolveChatActor(context, body);
      await requireOwnedSession(repository, sessionId, actor);
      const session = await repository.closeSession(sessionId);
      return { ok: true, session };
    },

    async sendMessage(context, body) {
      const input = validateChatInput(body);
      const actor = resolveChatActor(context, input);
      let session = null;
      let createdSession = false;

      if (input.sessionId) {
        session = await requireOwnedSession(repository, input.sessionId, actor);
      } else {
        createdSession = true;
        session = await repository.createSession({
          authUserId: actor.authUserId,
          profileUserId: actor.profileUserId,
          guestId: actor.guestId,
          title: buildSessionTitle(input.message),
          lastMessagePreview: input.message,
          metadata: {
            channel: "web",
            guest_email: input.guestEmail,
            guest_phone: input.guestPhone
          }
        });
      }

      let imageDescription = "";
      if (input.attachment && input.attachment.data) {
        try {
          console.log("[CHATBOT] Analyzing attached image with Gemini...");
          imageDescription = await analyzeImageWithGemini(
            input.attachment.data,
            input.attachment.mimeType || "image/jpeg",
            input.message
          );
          console.log("[CHATBOT] Gemini analyzed image result:", imageDescription);
        } catch (err) {
          console.error("[CHATBOT] Image analysis error:", err);
        }
      }

      const userMessage = await repository.insertMessage({
        sessionId: session.session_id,
        sender: "user",
        text: input.message,
        metadata: {
          mode: input.mode,
          source: "web",
          attachment: input.attachment || null
        },
        productIds: []
      });

      if (session && (session.handoff_status === "assigned" || session.handoff_status === "requested")) {
        // Admin is actively handling or has been requested — chatbot stays completely silent, return full history
        const recent = await repository.listMessages(session.session_id, 50);
        const products = await hydrateProductsForMessages(repository, recent.rows || []);
        const blogs = await hydrateBlogsForMessages(repository, recent.rows || []);
        const updatedSession = await repository.updateSession(session.session_id, {
          last_message_preview: input.message.slice(0, 180),
          last_message_at: new Date().toISOString()
        });
        return {
          session: updatedSession || session,
          createdSession: false,
          messages: recent.rows || [],
          products,
          blogs,
          handoff: { ticketId: session.support_ticket_id, status: session.handoff_status }
        };
      }

      const recent = await repository.listMessages(session.session_id, 16);
      const searchQuery = imageDescription ? `${input.message} ${imageDescription}` : input.message;
      const productSearch = await repository.searchProducts(searchQuery, 8);
      let candidateProducts = productSearch.rows || [];

      const isOrderOrSupport = /(đơn hàng|order|mã đơn|tracking|vận chuyển|giao hàng|đổi trả|bảo hành|chính sách|phí ship|miễn phí|size|kích cỡ|xin chào|chào|hello)/i.test(input.message);
      if (!isOrderOrSupport && !candidateProducts.length) {
        const fallbackSearch = await repository.searchProducts("", 6);
        candidateProducts = fallbackSearch.rows || [];
      }

      const conversationHistory = recent.rows || [];

      let n8nResult = { used: false };
      // n8n chatbot disabled per user request, routing directly to Gemini LLM
      if (false) {
        n8nResult = await callN8nWorkflow({
          session,
          actor,
          message: input.message,
          history: conversationHistory,
          products: candidateProducts.map(formatProductForWorkflow)
        });
      }

      // Escalation check based on user message handoff intent
      if (detectHandoffIntent(input.message)) {
        return handleHandoff({
          repository,
          actor,
          input,
          session,
          userMessage,
          createdSession
        });
      }

      let responseText;
      let selectedProducts = [];
      let selectedBlogs = [];
      let productIds = [];
      let blogIds = [];
      let llmResult = { used: false, metadata: {}, intent: "", blogs: [] };

      if (n8nResult.used && n8nResult.text) {
        responseText = n8nResult.text;
        productIds = n8nResult.productIds || [];
        if (productIds.length > 0) {
          selectedProducts = await selectResponseProducts(repository, productIds, []);
        }
        llmResult = {
          used: true,
          metadata: {
            ...n8nResult.metadata,
            n8n_used: true
          },
          intent: n8nResult.intent || "general",
          blogs: []
        };
      } else {
        let styleProfile = null;
        if (actor.profileUserId) {
          styleProfile = await repository.getStyleProfile(actor.profileUserId);
        }
        const previousInteractionId = session.metadata?.previous_interaction_id || null;

        const chatResult = await llm.chat(
          [...conversationHistory, { sender: "user", text: searchQuery }],
          candidateProducts,
          previousInteractionId,
          styleProfile,
          actor.profileUserId
        );
        responseText = chatResult.text || await getFallbackReply(input.message, candidateProducts, repository);
        selectedProducts = await selectResponseProducts(repository, chatResult.productIds, candidateProducts);

        // Suppress automatic product recommendations for non-product queries (e.g. policies, shipping, order, cskh)
        const textLower = String(input.message || "").toLowerCase();
        const isPolicyQuery = /(đổi trả|return|bảo hành|chính sách|policy|quy định|điều khoản|giao hàng|ship|vận chuyển|thanh toán|payment|refund|hoàn tiền)/i.test(textLower);
        const isHandoffQuery = detectHandoffIntent(input.message);
        if (isPolicyQuery || isHandoffQuery) {
          if (!chatResult.productIds || !chatResult.productIds.length) {
            selectedProducts = [];
          }
        }

        productIds = selectedProducts.map((product) => product.product_id);

        // Hydrate recommended blogs
        const rawBlogIds = chatResult.blogIds || [];
        if (rawBlogIds.length > 0) {
          const blogRes = await repository.listBlogsByIds(rawBlogIds);
          selectedBlogs = blogRes.rows || [];
          blogIds = selectedBlogs.map((b) => b.blog_id);
        }

        llmResult = {
          used: chatResult.used,
          interactionId: chatResult.interactionId,
          metadata: {
            ...chatResult.metadata,
            blog_ids: blogIds,
            n8n_error: n8nResult.metadata?.n8n_error || undefined
          },
          intent: chatResult.intent || "general",
          blogs: selectedBlogs
        };
      }

      const assistantMessage = await repository.insertMessage({
        sessionId: session.session_id,
        sender: "bot",
        text: responseText,
        metadata: {
          product_ids: productIds,
          blog_ids: blogIds,
          llm_used: llmResult.used,
          intent: llmResult.intent || "product_advice",
          ...llmResult.metadata
        },
        productIds
      });

      await repository.insertAiLog({
        profileUserId: actor.profileUserId,
        messages: buildAiLogMessages(session.session_id, recent.rows || [], userMessage, assistantMessage),
        recommendedProducts: productIds,
        escalatedToHuman: false
      });

      const updatedSession = await repository.updateSession(session.session_id, {
        last_message_preview: responseText.slice(0, 180),
        last_message_at: new Date().toISOString(),
        metadata: {
          ...(session.metadata || {}),
          last_product_ids: productIds,
          llm_used: llmResult.used,
          previous_interaction_id: llmResult.interactionId || session.metadata?.previous_interaction_id
        }
      });

      return {
        session: updatedSession || session,
        createdSession,
        messages: [userMessage, assistantMessage],
        products: selectedProducts.map(formatProductCard),
        blogs: (llmResult.blogs || []).map(formatBlogCard),
        handoff: null
      };
    },

    async saveFavorite(context, body) {
      if (!context.authUser?.id) {
        throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required to save favorites");
      }
      const { messageId, sessionId } = body;
      if (!messageId) throw new HttpError(400, "BAD_REQUEST", "messageId is required");

      const messages = await repository.listMessages(sessionId, 150);
      const message = (messages.rows || []).find(m => m.message_id === messageId);
      if (!message) throw new HttpError(404, "MESSAGE_NOT_FOUND", "Message not found");

      const productIds = normalizeUuidList(message.product_ids || []);

      const aiLog = await repository.insertAiLog({
        profileUserId: context.profile.user_id,
        messages: [{
          action: "save_favorite_outfit",
          message_id: messageId,
          session_id: sessionId,
          text: message.text
        }],
        recommendedProducts: productIds,
        escalatedToHuman: false
      });

      return { ok: true, logId: aiLog.log_id };
    },

    async syncFavorites(context, body) {
      if (!context.authUser?.id) {
        throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required to sync favorites");
      }
      const favorites = body.favorites || [];
      const synced = [];

      for (const fav of favorites) {
        if (!fav.product_ids || fav.product_ids.length === 0) continue;
        const aiLog = await repository.insertAiLog({
          profileUserId: context.profile.user_id,
          messages: [{
            action: "save_favorite_outfit",
            message_id: fav.message_id || fav.id,
            session_id: fav.session_id,
            text: fav.text || ""
          }],
          recommendedProducts: fav.product_ids,
          escalatedToHuman: false
        });
        synced.push(aiLog.log_id);
      }

      return { ok: true, count: synced.length };
    },

    async listAdminSessions(context, searchParams) {
      requireSupportAdmin(context);
      return repository.listAdminSessions({
        handoffOnly: searchParams.get("handoffOnly") !== "false",
        ticketId: searchParams.get("ticketId") || undefined,
        limit: boundedInteger(searchParams.get("limit"), 50, 1, 100),
        offset: boundedInteger(searchParams.get("offset"), 0, 0, 100000)
      });
    },

    async getAdminMessages(context, sessionId, searchParams) {
      requireSupportAdmin(context);
      requireUuid(sessionId, "sessionId");
      const session = await repository.getSession(sessionId);
      if (!session) throw new HttpError(404, "CHAT_SESSION_NOT_FOUND", "Chat session not found");
      const messages = await repository.listMessages(sessionId, boundedInteger(searchParams.get("limit"), 150, 1, 300));
      const products = await hydrateProductsForMessages(repository, messages.rows || []);
      const blogs = await hydrateBlogsForMessages(repository, messages.rows || []);
      return { session, messages: messages.rows || [], products, blogs };
    },

    async agentReply(context, sessionId, body) {
      requireSupportAdmin(context);
      requireUuid(sessionId, "sessionId");
      const session = await repository.getSession(sessionId);
      if (!session) throw new HttpError(404, "CHAT_SESSION_NOT_FOUND", "Chat session not found");
      if (session.handoff_status === "closed") {
        throw new HttpError(409, "CHAT_SESSION_CLOSED", "This chat session is already closed");
      }

      const text = normalizeText(body?.message || body?.text, 1, 2000, "message");
      const agentName = context?.profile?.full_name || "CSKH Velura";
      const now = new Date().toISOString();
      const isFirstAgentReply = session.handoff_status !== "assigned";

      // If this is the first agent reply, insert a system message so user knows CSKH joined
      if (isFirstAgentReply) {
        await repository.insertMessage({
          sessionId,
          sender: "bot",
          text: `${agentName} đã tham gia trò chuyện. Từ giờ bạn đang được hỗ trợ trực tiếp bởi nhân viên CSKH.`,
          metadata: { system: true, agent_joined: true, agent_name: agentName },
          productIds: []
        });
      }

      const agentMessage = await repository.insertMessage({
        sessionId,
        sender: "agent",
        text,
        metadata: {
          agent_id: context.authUser?.id,
          agent_name: agentName,
          source: "admin_panel"
        },
        productIds: []
      });

      const updatedSession = await repository.updateSession(sessionId, {
        handoff_status: "assigned",
        assigned_to: context.authUser?.id,
        last_message_preview: text.slice(0, 180),
        last_message_at: now,
        metadata: {
          ...(session.metadata || {}),
          agent_assigned_at: session.metadata?.agent_assigned_at || now,
          agent_last_reply_at: now,
          agent_id: context.authUser?.id
        }
      });

      if (session.support_ticket_id) {
        await repository.updateSupportTicket(session.support_ticket_id, {
          status: "processing",
          admin_reply: text
        });
      }

      return { session: updatedSession || session, message: agentMessage };
    },

    async assignSession(context, sessionId, body) {
      requireSupportAdmin(context);
      requireUuid(sessionId, "sessionId");
      const session = await repository.getSession(sessionId);
      if (!session) throw new HttpError(404, "CHAT_SESSION_NOT_FOUND", "Chat session not found");

      const status = body?.status === "closed" ? "closed" : "assigned";
      const now = new Date().toISOString();
      if (session.handoff_status === "closed" && status !== "closed") {
        throw new HttpError(409, "CHAT_SESSION_CLOSED", "This chat session is already closed");
      }
      const updated = await repository.updateSession(sessionId, {
        handoff_status: status,
        assigned_to: context.authUser?.id,
        metadata: {
          ...(session.metadata || {}),
          ...(status === "closed" ? { closed_at: now } : { assigned_at: session.metadata?.assigned_at || now }),
          agent_id: context.authUser?.id
        }
      });

      if (status !== "closed") {
        const agentName = context?.profile?.full_name || "CSKH Velura";
        await repository.insertMessage({
          sessionId,
          sender: "bot",
          text: `${agentName} đã tham gia trò chuyện. Từ giờ bạn đang được hỗ trợ trực tiếp bởi nhân viên CSKH.`,
          metadata: { system: true, agent_joined: true, agent_name: agentName },
          productIds: []
        });
      }

      if (session.support_ticket_id) {
        await repository.updateSupportTicket(session.support_ticket_id, {
          status: status === "closed" ? "closed" : "processing",
          ...(status === "closed" ? { resolved_at: now } : {})
        });
      }

      return { session: updated || session };
    }
  };
}

async function handleHandoff({ repository, actor, input, session, userMessage, createdSession }) {
  const existingMetadata = session.metadata || {};
  const aiLog = await repository.insertAiLog({
    profileUserId: actor.profileUserId,
    messages: [{
      role: "user",
      content: input.message,
      sessionId: session.session_id,
      createdAt: userMessage.created_at
    }],
    recommendedProducts: [],
    escalatedToHuman: true
  });

  const ticket = await repository.createSupportTicket({
    profileUserId: actor.profileUserId,
    guestEmail: input.guestEmail || cleanEmail(existingMetadata.guest_email),
    guestPhone: input.guestPhone || cleanPhone(existingMetadata.guest_phone),
    title: `Chat CSKH ${shortSessionId(session.session_id)}`,
    description: buildSupportDescription(session, input.message, actor),
    priority: "high",
    aiLogId: aiLog?.log_id || null
  });
  const replyText = buildTicketHandoffReply(ticket.ticket_id);

  const assistantMessage = await repository.insertMessage({
    sessionId: session.session_id,
    sender: "bot",
    text: replyText,
    metadata: {
      handoff: true,
      ticket_id: ticket.ticket_id
    },
    productIds: []
  });

  await repository.updateSession(session.session_id, {
    handoff_status: "requested",
    support_ticket_id: ticket.ticket_id,
    last_message_preview: replyText.slice(0, 180),
    last_message_at: new Date().toISOString(),
    metadata: {
      ...existingMetadata,
      handoff_requested_at: new Date().toISOString(),
      support_ticket_id: ticket.ticket_id
    }
  });

  await queueSupportAlert(repository, {
    ticket,
    session,
    message: input.message,
    actor,
    guestEmail: input.guestEmail || cleanEmail(existingMetadata.guest_email),
    guestPhone: input.guestPhone || cleanPhone(existingMetadata.guest_phone)
  });

  return {
    session: {
      ...session,
      handoff_status: "requested",
      support_ticket_id: ticket.ticket_id
    },
    createdSession,
    messages: [userMessage, assistantMessage],
    products: [],
    blogs: [],
    handoff: { ticketId: ticket.ticket_id, status: "requested" }
  };
}

async function callN8nWorkflow(payload) {
  if (!config.n8nChatWebhookUrl) {
    return { used: false, text: "", productIds: [], metadata: {}, intent: "" };
  }
  try {
    const response = await fetch(config.n8nChatWebhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.n8nChatWebhookToken ? { authorization: `Bearer ${config.n8nChatWebhookToken}` } : {})
      },
      body: JSON.stringify({
        session_id: payload.session.session_id,
        guest_id: payload.actor.guestId || null,
        user_id: payload.actor.profileUserId || null,
        message: payload.message,
        history: payload.history.map((item) => ({
          sender: item.sender,
          text: item.text,
          created_at: item.created_at,
          metadata: item.metadata || {}
        })),
        products: payload.products
      }),
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    });
    if (!response.ok) {
      return { used: false, text: "", productIds: [], metadata: { n8n_error: `HTTP ${response.status}` }, intent: "" };
    }
    const data = await response.json().catch(() => ({}));
    return { used: true, ...normalizeN8nResponse(data) };
  } catch (error) {
    return {
      used: false,
      text: "",
      productIds: [],
      metadata: { n8n_error: error.name === "TimeoutError" ? "timeout" : "unavailable" },
      intent: ""
    };
  }
}

export function normalizeN8nResponse(payload) {
  let data = payload;
  if (Array.isArray(data)) data = data[0]?.json || data[0] || {};
  if (data?.json) data = data.json;
  if (data?.response && typeof data.response === "object") data = data.response;
  if (data?.data && typeof data.data === "object") data = data.data;

  const textValue = typeof data === "string"
    ? data
    : data?.response || data?.text || data?.reply || data?.answer || data?.output || data?.message || "";
  const metadata = typeof data === "object" && data ? (data.metadata || {}) : {};
  const productIds = normalizeUuidList(
    data?.product_ids ||
    data?.productIds ||
    metadata.product_ids ||
    metadata.productIds ||
    []
  );

  return {
    text: String(textValue || "").trim().slice(0, 4000),
    responseHtml: data?.response_html || "",
    productIds,
    metadata,
    intent: data?.intent || metadata.intent || ""
  };
}

async function selectResponseProducts(repository, productIds, candidateProducts) {
  const ids = normalizeUuidList(productIds);
  let products = [];
  if (ids.length) {
    const result = await repository.listProductsByIds(ids);
    const byId = new Map((result.rows || []).map((product) => [product.product_id, product]));
    products = ids.map((id) => byId.get(id)).filter(Boolean);
  }
  if (!products.length) {
    products = candidateProducts.slice(0, 3);
  }
  return products.slice(0, 6);
}

async function hydrateProductsForMessages(repository, messages) {
  const ids = normalizeUuidList(messages.flatMap((message) => [
    ...(message.product_ids || []),
    ...((message.metadata || {}).product_ids || [])
  ]));
  if (!ids.length) return [];
  const result = await repository.listProductsByIds(ids);
  const byId = new Map((result.rows || []).map((product) => [product.product_id, product]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map(formatProductCard);
}

export function validateChatInput(body = {}) {
  const hasAttachment = !!(body.attachment || body.attachments);
  const minLength = hasAttachment ? 0 : 1;
  const message = normalizeText(body.message ?? body.text ?? "", minLength, 1000, "message");
  const sessionId = body.sessionId || body.session_id || "";
  if (sessionId) requireUuid(sessionId, "sessionId");
  return {
    sessionId: sessionId || "",
    guestId: body.guestId || body.guest_id || "",
    guestEmail: cleanEmail(body.guestEmail || body.guest_email),
    guestPhone: cleanPhone(body.guestPhone || body.guest_phone),
    mode: ["guest", "user"].includes(body.mode) ? body.mode : "guest",
    message: message || (hasAttachment ? "Gửi hình ảnh đính kèm" : ""),
    attachment: body.attachment || null
  };
}

function resolveChatActor(context, input = {}) {
  const profileUserId = context?.profile?.user_id || "";
  const authUserId = context?.authUser?.id && context?.profile ? context.authUser.id : "";
  const guestId = String(input.guestId || input.guest_id || "").trim();

  if (!profileUserId) {
    requireUuid(guestId, "guestId");
  } else if (guestId) {
    requireUuid(guestId, "guestId");
  }

  return {
    authUserId,
    profileUserId,
    guestId: guestId || null
  };
}

async function requireOwnedSession(repository, sessionId, actor) {
  const session = await repository.getSession(sessionId);
  if (!session || !session.is_active) {
    throw new HttpError(404, "CHAT_SESSION_NOT_FOUND", "Chat session not found");
  }
  if (session.profile_user_id) {
    if (!actor.profileUserId || session.profile_user_id !== actor.profileUserId) {
      throw new HttpError(403, "CHAT_SESSION_FORBIDDEN", "This chat session belongs to another user");
    }
  } else {
    if (!actor.guestId || String(session.guest_id || "") !== actor.guestId) {
      throw new HttpError(403, "CHAT_SESSION_FORBIDDEN", "This chat session belongs to another visitor");
    }
  }
  return session;
}

export function detectHandoffIntent(message) {
  const text = String(message || "").toLowerCase();
  return [
    "nhân viên",
    "tu van vien",
    "tư vấn viên",
    "chăm sóc khách hàng",
    "cskh",
    "người thật",
    "gap nguoi",
    "gặp người",
    "support",
    "hotline",
    "nối máy",
    "noi may",
    "ticket",
    "phiếu hỗ trợ",
    "phieu ho tro",
    "tạo phiếu",
    "tao phieu",
    "tạo yêu cầu",
    "tao yeu cau",
    "yêu cầu hỗ trợ",
    "yeu cau ho tro",
    "khiếu nại",
    "khieu nai",
    "phản ánh",
    "phan anh"
  ].some((keyword) => text.includes(keyword));
}

export async function getFallbackReply(message, products = [], repository = null) {
  const text = String(message || "").toLowerCase();

  if (detectHandoffIntent(message)) {
    return HANDOFF_REPLY;
  }

  const isOrderQuery = /(đơn hàng|order|mã đơn|tracking|vận chuyển|giao hàng|ship|thanh toán|payment|refund|hoàn tiền)/i.test(text);
  if (isOrderQuery) {
    return "Để kiểm tra đơn hàng, bạn vui lòng cung cấp mã đơn hàng (VD: ORD-...) hoặc số điện thoại đặt hàng. Mình sẽ tra cứu trạng thái đơn giúp bạn ngay.";
  }

  const isPolicyQuery = /(đổi trả|return|bảo hành|chính sách|policy|quy định|điều khoản)/i.test(text);
  if (isPolicyQuery) {
    if (repository) {
      try {
        console.log("[FALLBACK-RAG] Querying policies from repository...");
        const result = await repository.searchPolicies(message);
        const policies = result.rows || [];
        if (policies.length > 0) {
          return policies.map(p => {
            let contentStr = "";
            if (Array.isArray(p.content)) {
              contentStr = p.content.map(section => {
                const heading = section.heading ? `**${section.heading}**\n` : "";
                const items = Array.isArray(section.items)
                  ? section.items.map(item => `- ${item}`).join('\n')
                  : `  - ${section.text || ""}`;
                return heading + items;
              }).join('\n');
            } else {
              contentStr = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
            }
            return `=== ${p.title} ===\nTóm tắt: ${p.summary}\nChi tiết:\n${contentStr}`;
          }).join('\n\n');
        }
      } catch (err) {
        console.warn("[FALLBACK-RAG] Failed to search policies:", err.message);
      }
    }
    return "Mình chưa tải được dữ liệu chính sách mới nhất từ database ở thời điểm này nên sẽ không dùng thông tin cũ để trả lời. Bạn có thể mở trang Chính sách trên website hoặc liên hệ CSKH Velura qua hotline 1900 1212 để được xác nhận chính xác nhất nhé.";
  }

  const isShippingQuery = /(phí ship|phí vận chuyển|miễn phí|free ship|giao mất bao lâu|thời gian giao)/i.test(text);
  if (isShippingQuery) {
    return "Chính sách vận chuyển Velura: phí vận chuyển tiêu chuẩn toàn quốc là 30.000đ; miễn phí vận chuyển cho đơn từ 500.000đ. Nội thành TP.HCM và Hà Nội dự kiến 1 - 3 ngày làm việc, các tỉnh thành khác 3 - 5 ngày làm việc.";
  }

  const isSizeQuery = /(size|kích cỡ|số đo|vừa người|đo size|bảng size)/i.test(text);
  if (isSizeQuery) {
    return "Bảng size Velura:\n- S: Vòng eo 62-66cm,Ngực 80-84cm\n- M: Vòng eo 66-70cm, Ngực 84-88cm\n- L: Vòng eo 70-74cm, Ngực 88-92cm\n- XL: Vòng eo 74-78cm, Ngực 92-96cm\n\nBạn có thể cung cấp số đo cụ thể để mình tư vấn size phù hợp nhất.";
  }

  const isGreeting = /^(xin chào|chào|hello|hi|hey|alo|chào bạn|good morning|chào buổi)/i.test(text);
  if (isGreeting) {
    return DEFAULT_ASSISTANT_GREETING;
  }

  if (products.length) {
    const names = products.slice(0, 3).map((product) => product.name).join(", ");
    return `Mình tìm thấy vài gợi ý hợp với yêu cầu của bạn: ${names}. Bạn có thể xem nhanh các mẫu bên dưới, hoặc nói thêm về màu sắc, dịp mặc và khoảng giá để mình lọc sát hơn.`;
  }

  return "Mình đã nhận được câu hỏi của bạn. Bạn có thể nói thêm về dịp mặc, màu sắc yêu thích, dáng người hoặc khoảng giá để mình tư vấn sát hơn nhé.";
}

export function createFallbackReply(message, products = []) {
  const text = String(message || "").toLowerCase();

  if (detectHandoffIntent(message)) {
    return HANDOFF_REPLY;
  }

  const isOrderQuery = /(đơn hàng|order|mã đơn|tracking|vận chuyển|giao hàng|ship|thanh toán|payment|refund|hoàn tiền)/i.test(text);
  if (isOrderQuery) {
    return "Để kiểm tra đơn hàng, bạn vui lòng cung cấp mã đơn hàng (VD: ORD-...) hoặc số điện thoại đặt hàng. Mình sẽ tra cứu trạng thái đơn giúp bạn ngay.";
  }

  const isPolicyQuery = /(đổi trả|return|bảo hành|chính sách|policy|quy định|điều khoản)/i.test(text);
  if (isPolicyQuery) {
    return "Chính sách đổi trả Velura: khách hàng cần gửi yêu cầu trong vòng tối đa 2 ngày (48 giờ) kể từ lúc đơn hàng cập nhật trạng thái \"Đã giao thành công\". Sản phẩm phải chưa qua sử dụng, còn nguyên tem mác, nhãn barcode và bao bì đóng gói gốc của Velura. Hoàn tiền được xử lý trong 4 - 5 ngày làm việc sau khi hàng về kho đạt tiêu chuẩn kiểm tra.";
  }

  const isShippingQuery = /(phí ship|phí vận chuyển|miễn phí|free ship|giao mất bao lâu|thời gian giao)/i.test(text);
  if (isShippingQuery) {
    return "Chính sách vận chuyển Velura: phí vận chuyển tiêu chuẩn toàn quốc là 30.000đ; miễn phí vận chuyển cho đơn từ 500.000đ. Nội thành TP.HCM và Hà Nội dự kiến 1 - 3 ngày làm việc, các tỉnh thành khác 3 - 5 ngày làm việc.";
  }

  const isSizeQuery = /(size|kích cỡ|số đo|vừa người|đo size|bảng size)/i.test(text);
  if (isSizeQuery) {
    return "Bảng size Velura:\n- S: Vòng eo 62-66cm,Ngực 80-84cm\n- M: Vòng eo 66-70cm, Ngực 84-88cm\n- L: Vòng eo 70-74cm, Ngực 88-92cm\n- XL: Vòng eo 74-78cm, Ngực 92-96cm\n\nBạn có thể cung cấp số đo cụ thể để mình tư vấn size phù hợp nhất.";
  }

  const isGreeting = /^(xin chào|chào|hello|hi|hey|alo|chào bạn|good morning|chào buổi)/i.test(text);
  if (isGreeting) {
    return DEFAULT_ASSISTANT_GREETING;
  }

  if (products.length) {
    const names = products.slice(0, 3).map((product) => product.name).join(", ");
    return `Mình tìm thấy vài gợi ý hợp với yêu cầu của bạn: ${names}. Bạn có thể xem nhanh các mẫu bên dưới, hoặc nói thêm về màu sắc, dịp mặc và khoảng giá để mình lọc sát hơn.`;
  }

  return "Mình đã nhận được câu hỏi của bạn. Bạn có thể nói thêm về dịp mặc, màu sắc yêu thích, dáng người hoặc khoảng giá để mình tư vấn sát hơn nhé.";
}

function buildTicketHandoffReply(ticketId) {
  return [
    HANDOFF_REPLY,
    "",
    `Mã ticket hỗ trợ của bạn: ${ticketId}.`,
    "Trong lúc chờ CSKH tiếp nhận, bạn có thể nhắn thêm số điện thoại/email hoặc mô tả chi tiết nhu cầu để Velura hỗ trợ nhanh hơn nhé."
  ].join("\n");
}

function formatProductForWorkflow(product) {
  return {
    product_id: product.product_id,
    sku: product.sku,
    name: product.name,
    category: product.category?.name || "",
    price: Number(product.sale_price || product.base_price || 0),
    style_tags: product.style_tags || [],
    occasions: product.occasions || [],
    description: product.description || ""
  };
}

function formatProductCard(product) {
  const variant = firstAvailableVariant(product);
  return {
    product_id: product.product_id,
    sku: product.sku,
    name: product.name,
    slug: product.slug,
    description: product.description || "",
    image_url: Array.isArray(product.images) && product.images.length ? product.images[0] : "/src/assets/images/placeholder.jpg",
    base_price: Number(product.base_price || 0),
    sale_price: Number(product.sale_price || product.base_price || 0),
    price: Number(product.sale_price || product.base_price || 0),
    category_name: product.category?.name || "",
    category_slug: product.category?.slug || "",
    detail_url: `/src/pages/products/detail.html?id=${product.product_id}`,
    variant: variant ? {
      variant_id: variant.variant_id,
      color: variant.color || "Mặc định",
      size: variant.size || "M",
      stock_quantity: Number(variant.stock_quantity || 0),
      reserved_quantity: Number(variant.reserved_quantity || 0)
    } : null
  };
}

function formatBlogCard(blog) {
  return {
    blog_id: blog.blog_id,
    slug: blog.slug,
    title: blog.title,
    excerpt: blog.excerpt,
    image_url: blog.image_url || "/src/assets/images/placeholder.jpg",
    author: blog.author,
    read_minutes: blog.read_minutes,
    detail_url: `/src/pages/blog/blog-detail.html?slug=${blog.slug}`
  };
}

async function hydrateBlogsForMessages(repository, messages) {
  const ids = normalizeUuidList(messages.flatMap((message) => [
    ...((message.metadata || {}).blog_ids || [])
  ]));
  if (!ids.length) return [];
  const result = await repository.listBlogsByIds(ids);
  return (result.rows || []).map(formatBlogCard);
}

function firstAvailableVariant(product) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  return variants.find((variant) => Number(variant.stock_quantity || 0) > Number(variant.reserved_quantity || 0)) || variants[0] || null;
}

function buildAiLogMessages(sessionId, history, userMessage, assistantMessage) {
  return [
    ...history.slice(-12).map((item) => ({
      role: item.sender,
      content: item.text,
      createdAt: item.created_at
    })),
    { role: "user", content: userMessage.text, createdAt: userMessage.created_at },
    { role: "assistant", content: assistantMessage.text, createdAt: assistantMessage.created_at, productIds: assistantMessage.product_ids || [] }
  ].map((item) => ({ ...item, sessionId }));
}

function buildSupportDescription(session, message, actor) {
  return [
    `Khách yêu cầu gặp nhân viên từ chatbot Velura.`,
    `Chat session: ${session.session_id}`,
    actor.profileUserId ? `User ID: ${actor.profileUserId}` : `Guest ID: ${actor.guestId}`,
    "",
    "Tin nhắn gần nhất:",
    message
  ].join("\n");
}

async function queueSupportAlert(repository, input) {
  if (!config.supportAlertTo) return null;
  const body = [
    "Velura có yêu cầu nối nhân viên CSKH từ chatbot.",
    "",
    `Ticket: ${input.ticket.ticket_id}`,
    `Session: ${input.session.session_id}`,
    input.actor.profileUserId ? `User ID: ${input.actor.profileUserId}` : `Guest ID: ${input.actor.guestId || "-"}`,
    input.guestEmail ? `Guest email: ${input.guestEmail}` : "",
    input.guestPhone ? `Guest phone: ${input.guestPhone}` : "",
    "",
    "Tin nhắn:",
    input.message
  ].filter(Boolean).join("\n");

  return repository.queueEmail({
    recipient: config.supportAlertTo,
    templateCode: "chatbot_handoff_alert",
    subject: `[Velura CSKH] Chatbot cần nhân viên - ${shortSessionId(input.session.session_id)}`,
    body,
    relatedUserId: input.actor.profileUserId || null,
    metadata: {
      ticketId: input.ticket.ticket_id,
      sessionId: input.session.session_id,
      source: "chatbot"
    }
  });
}

function requireSupportAdmin(context) {
  if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
  if (!CHAT_SUPPORT_ROLES.includes(context.roleCode)) {
    throw new HttpError(403, "RBAC_DENIED", "Only CSKH operator or super admin can view chatbot handoffs");
  }
}

function buildSessionTitle(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return (clean || "Tư vấn Velura").slice(0, 80);
}

function normalizeText(value, minLength, maxLength, field) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length < minLength || text.length > maxLength) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", {
      [field]: [`${field} must contain ${minLength} to ${maxLength} characters`]
    });
  }
  return text;
}

function cleanEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 255) : "";
}

function cleanPhone(value) {
  const phone = String(value || "").replace(/[^\d+]/g, "").slice(0, 20);
  return phone.length >= 8 ? phone : "";
}

function shortSessionId(sessionId) {
  return String(sessionId || "").slice(0, 8);
}

function normalizeUuidList(values) {
  let list = [];
  if (Array.isArray(values)) {
    list = values;
  } else {
    const cleanStr = String(values || "").replace(/^\{|\}$/g, "");
    list = cleanStr.split(",");
  }
  const seen = new Set();
  const result = [];
  for (const value of list) {
    const id = String(value || "").trim();
    if (!isUuid(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function requireUuid(value, field) {
  if (!isUuid(String(value || ""))) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", {
      [field]: [`${field} must be a UUID`]
    });
  }
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}
