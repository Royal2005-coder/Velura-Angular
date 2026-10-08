import { verifyJwt } from "../auth-helper.js";
import { analyzeImageWithGemini } from "../gemini-client.js";
import { HttpError } from "../http.js";
import { asJsonObject, asNumber, asString, isJsonObject, type AuthContext, type JsonObject } from "../types.js";
import { CHAT_SUPPORT_ROLES, DEFAULT_ASSISTANT_GREETING } from "./chatbot-constants.js";
import type { ChatbotRepository } from "./chatbot-repository.js";
import type { ChatActor, ChatAnalysis, ChatModel, ChatSource } from "./chatbot-types.js";
import { createLLMService, responseRiskCheck } from "./llm-service.js";

/** Validated public turn; OTP tokens never enter model context or message metadata. */
export interface ChatInput {
  sessionId: string; guestId: string; message: string; attachment: JsonObject | null; orderId: string; guestAccessToken: string;
}

/** Existing storefront/admin routes plus restricted moderation and review APIs. */
export interface ChatbotService {
  /** Lists only the active sessions owned by the resolved member or guest. */
  listSessions(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<unknown>;
  /** Creates an owned session and persists its first assistant introduction. */
  createSession(context: AuthContext | undefined, body: JsonObject): Promise<unknown>;
  /** Returns an owner's transcript without moderated originals or internal review context. */
  getMessages(context: AuthContext | undefined, sessionId: string, searchParams: URLSearchParams): Promise<unknown>;
  /** Closes an owned session, preventing new or late AI turns. */
  deleteSession(context: AuthContext | undefined, sessionId: string, body?: JsonObject): Promise<unknown>;
  /** Authenticates selected orders, grounds/reviews replies and escalates finite model failures; never performs commerce writes. */
  sendMessage(context: AuthContext | undefined, body: JsonObject): Promise<unknown>;
  /** Saves a member's existing assistant recommendation, never client-provided product data. */
  saveFavorite(context: AuthContext | undefined, body: JsonObject): Promise<unknown>;
  /** Imports only favorites backed by owned sessions and persisted assistant messages. */
  syncFavorites(context: AuthContext | undefined, body: JsonObject): Promise<unknown>;
  /** Lists CSKH sessions for active authorized staff with restricted previews. */
  listAdminSessions(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<unknown>;
  /** Returns safe staff classification labels, not restricted originals or classification context. */
  getAdminMessages(context: AuthContext | undefined, sessionId: string, searchParams: URLSearchParams): Promise<unknown>;
  /** Atomically takes over the session and persists a human reply, suppressing late AI responses. */
  agentReply(context: AuthContext | undefined, sessionId: string, body: JsonObject): Promise<unknown>;
  /** Takes over or closes a session; SQL preserves supervisor-only handling. */
  assignSession(context: AuthContext | undefined, sessionId: string, body: JsonObject): Promise<unknown>;
  /** Records human classifications/outcomes without automatic training; moderation requires confirmed=true. */
  reviewSession(context: AuthContext | undefined, sessionId: string, body: JsonObject): Promise<unknown>;
  /** Allows only a supervisor to access a restricted original and durably audits that access. */
  moderatedOriginal(context: AuthContext | undefined, sessionId: string, messageId: string): Promise<unknown>;
  /** Allows only a supervisor to approve the current published policy version with a bounded expiry. */
  approvePolicy(context: AuthContext | undefined, policyId: string, body: JsonObject): Promise<unknown>;
}

/** Business rules run before persistence; SQL locks enforce takeover across API processes. */
export function createChatbotService({ repository, model = createLLMService() }: { repository: ChatbotRepository; model?: ChatModel }): ChatbotService {
  if (!repository) throw new TypeError("repository is required");

  async function transcript(session: JsonObject, staff = false) {
    const result = await repository.listMessages(asString(session.session_id), 150);
    const messages = (result.rows || []).map((row) => publicMessage(row, staff));
    const ids = messages.flatMap((row) => Array.isArray(row.product_ids) ? row.product_ids : []);
    const products = (await repository.listProductsByIds(ids)).rows || [];
    return { session: publicSession(session, staff), messages, products: products.map(formatProductCard), blogs: [], handoff: session.support_ticket_id ? { ticketId: session.support_ticket_id, status: session.handoff_status } : null };
  }

  async function escalate(session: JsonObject, actor: ChatActor, message: JsonObject, analysis: ChatAnalysis, history: JsonObject[], reason: string, verified: boolean) {
    const restricted = ["orange", "red"].includes(analysis.risk) && analysis.moderation !== "none";
    const result = await repository.handoff(asString(session.session_id), actor, {
      summary: restricted ? "[Nội dung được kiểm duyệt — cần giám sát]" : `${analysis.context.problem} — ${analysis.context.wanted}`.slice(0, 2000),
      problem: restricted ? "[Nội dung được kiểm duyệt]" : analysis.context.problem,
      wanted: restricted ? "Giám sát xử lý nội dung nghiêm trọng" : analysis.context.wanted,
      attempts: history.filter((item) => item.sender === "bot").map((item) => ({ text: asString(item.text).slice(0, 1000), approach: asJsonObject(item.metadata).approach })),
      failed_approaches: restricted ? [] : analysis.context.failedApproaches,
      verified_status: actor.profileUserId ? "member_account" : verified ? "guest_order_otp" : "unverified_guest",
      risk: analysis.risk, intent: analysis.intent, issue: analysis.issue, user_message_id: message.message_id
    }, reason, analysis.risk === "red");
    return transcript(isJsonObject(result.session) ? result.session : { ...session, handoff_status: "requested", support_ticket_id: result.ticket_id });
  }

  return {
    async listSessions(context, searchParams) {
      const actor = resolveChatActor(context, { guestId: searchParams.get("guestId") });
      const result = await repository.listSessions({ profileUserId: actor.profileUserId, guestId: actor.guestId, limit: integer(searchParams.get("limit"), 30, 100), offset: integer(searchParams.get("offset"), 0, 100000) });
      return { ...result, rows: (result.rows || []).map((row) => publicSession(row)) };
    },
    async createSession(context, body) {
      const actor = resolveChatActor(context, body);
      const session = await repository.createSession({ ...actor, title: asString(body.title || body.message || "Tư vấn Velura").slice(0, 80), lastMessagePreview: DEFAULT_ASSISTANT_GREETING, metadata: { channel: "web" } });
      const greeting = await repository.insertMessage({ sessionId: asString(session.session_id), sender: "bot", text: DEFAULT_ASSISTANT_GREETING, metadata: { system: true, speaker: "AI" }, productIds: [] });
      return { session: publicSession(session), messages: [publicMessage(greeting)], products: [], blogs: [] };
    },
    async getMessages(context, sessionId, searchParams) {
      return transcript(await requireOwnedSession(repository, sessionId, resolveChatActor(context, { guestId: searchParams.get("guestId") })));
    },
    async deleteSession(context, sessionId, body = {}) {
      await requireOwnedSession(repository, sessionId, resolveChatActor(context, body));
      return { ok: true, session: publicSession(await repository.closeSession(sessionId) || {}) };
    },
    async sendMessage(context, body) {
      const input = validateChatInput(body);
      const actor = resolveChatActor(context, input);
      let session = input.sessionId ? await requireOwnedSession(repository, input.sessionId, actor) : await repository.createSession({ ...actor, title: input.message.slice(0, 80), metadata: { channel: "web" } });
      const sessionId = asString(session.session_id);
      let order: JsonObject | null = null;
      if (input.orderId) {
        if (!actor.profileUserId && input.guestAccessToken) {
          const claims = verifyJwt(input.guestAccessToken);
          if (!claims || claims.purpose !== "guest_order_session" || claims.verified_order_id !== input.orderId || typeof claims.otp_challenge_id !== "string" || typeof claims.phone !== "string" || typeof claims.exp !== "number") throw new HttpError(401, "CHAT_ORDER_OTP_REQUIRED", "Xác thực OTP cho đúng đơn hàng trước khi tra cứu");
          await repository.grantOrder(sessionId, actor.guestId!, input.orderId, claims.phone, new Date(claims.exp * 1000).toISOString(), claims.otp_challenge_id);
        }
        order = await repository.readAuthorizedOrder(sessionId, actor, input.orderId);
      }
      const turn = await repository.appendUserTurn(sessionId, actor, input.message, { attachment: input.attachment, source: "web" });
      session = isJsonObject(turn.session) ? turn.session : session;
      const userMessage = asJsonObject(turn.message);
      if (session.handoff_status !== "ai") return transcript(session);
      const history = (await repository.listMessages(sessionId, 16)).rows || [];
      let analysis: ChatAnalysis;
      if (detectHandoffIntent(input.message)) {
        analysis = humanAnalysis(input.message);
      } else {
        try { analysis = await model.analyze(input.message, history); }
        catch {
          const state = await repository.recordAnalysis(sessionId, asString(userMessage.message_id), "model_failure", {}, true);
          if (asNumber(state.ai_failures) >= 2) return escalate(session, actor, userMessage, humanAnalysis(input.message), history, "REPEATED_MODEL_FAILURE", Boolean(order));
          const notice = await repository.commitAiTurn(sessionId, asNumber(turn.epoch), asNumber(userMessage.sequence), { text: "Hệ thống AI chưa xử lý được yêu cầu này. Bạn có thể yêu cầu gặp nhân viên CSKH.", metadata: { system: true, model_failure: true }, product_ids: [] }, []);
          return transcript(isJsonObject(notice.session) ? notice.session : session);
        }
      }
      // Emotion does not authorize moderation or account restrictions.
      if (analysis.moderation === "none" && ["orange", "red"].includes(analysis.risk)) analysis.risk = "yellow";
      const issueKey = `${analysis.issue}:${input.orderId || "conversation"}:${analysis.context.issueKey.normalize("NFKC").toLocaleLowerCase("vi").replace(/\s+/g, " ").trim()}`;
      const state = await repository.recordAnalysis(sessionId, asString(userMessage.message_id), issueKey, analysis as unknown as JsonObject, false);
      if (analysis.intent === "human" || analysis.level === "L3" || analysis.context.authorityExceeded || analysis.context.compromiseFailed || analysis.risk === "red" || asNumber(state.occurrences) >= 3) {
        const reason = analysis.context.authorityExceeded ? "AUTHORITY_EXCEEDED" : analysis.context.compromiseFailed ? "COMPROMISE_FAILED" : analysis.risk === "red" ? "SEVERE_CONTENT" : asNumber(state.occurrences) >= 3 ? "THIRD_SAME_ISSUE" : "HUMAN_REQUEST";
        return escalate(session, actor, userMessage, analysis, history, reason, Boolean(order));
      }
      if (analysis.risk === "orange" && analysis.moderation !== "none") return escalate(session, actor, userMessage, analysis, history, "CONTENT_MODERATION", Boolean(order));
      if (analysis.intent === "order" && !order) {
        const result = await repository.commitAiTurn(sessionId, asNumber(turn.epoch), asNumber(userMessage.sequence), { text: "Để bảo vệ thông tin riêng tư, hãy chọn đúng đơn hàng và đăng nhập tài khoản sở hữu đơn hoặc xác thực OTP của đơn đó. Mình không tra cứu bằng tên, số điện thoại hay mã đơn trong tin nhắn.", metadata: { system: true, otp_required: !actor.profileUserId }, product_ids: [] }, []);
        return transcript(isJsonObject(result.session) ? result.session : session);
      }
      let sources: ChatSource[];
      try {
        let query = input.message;
        if (input.attachment) query += `\nUntrusted image description: ${await analyzeImageWithGemini(asString(input.attachment.data), asString(input.attachment.mimeType), input.message)}`;
        sources = await loadSources(repository, analysis, query, order);
        const draft = await model.draft(input.message, history, analysis, sources);
        const deterministic = responseRiskCheck(analysis, draft, sources);
        if (!deterministic.safe) return escalate(session, actor, userMessage, analysis, history, deterministic.reasons.join(","), Boolean(order));
        // Fresh catalog/policy reads precede the final review; SQL checks again at commit.
        const current = await refreshSources(repository, sources, sessionId, actor);
        if (!current) return escalate(session, actor, userMessage, analysis, history, "SOURCE_STALE", Boolean(order));
        const risk = await model.review(input.message, analysis, draft, current);
        if (!risk.safe) return escalate(session, actor, userMessage, analysis, history, `RISK_REJECTED:${risk.reasons.join(",")}`.slice(0, 1000), Boolean(order));
        const result = await repository.commitAiTurn(sessionId, asNumber(turn.epoch), asNumber(userMessage.sequence), {
          text: draft.text, product_ids: draft.productIds,
          metadata: { speaker: "AI", analysis, approach: draft.approach, source_ids: draft.claims.map((claim) => claim.sourceId), risk_check: "passed" }
        }, current.map((source) => ({ kind: source.kind, id: source.recordId, version: source.version, approved: source.approved, snapshot: source.snapshot })));
        if (result.reason === "SOURCE_STALE") return escalate(session, actor, userMessage, analysis, history, "SOURCE_STALE", Boolean(order));
        return transcript(isJsonObject(result.session) ? result.session : await repository.getSession(sessionId) || session);
      } catch {
        // No draft, provider exception, or failed reviewer is ever sent to the user.
        const failure = await repository.recordAnalysis(sessionId, asString(userMessage.message_id), issueKey, {}, true);
        return escalate(session, actor, userMessage, analysis, history, asNumber(failure.ai_failures) >= 2 ? "REPEATED_MODEL_FAILURE" : "RESPONSE_CHECK_UNAVAILABLE", Boolean(order));
      }
    },
    async saveFavorite(context, body) {
      const actor = resolveChatActor(context, body);
      if (!actor.profileUserId) throw new HttpError(401, "AUTH_REQUIRED", "Đăng nhập để lưu gợi ý");
      await requireOwnedSession(repository, asString(body.sessionId), actor);
      const message = (await repository.listMessages(asString(body.sessionId), 300)).rows?.find((row) => row.message_id === body.messageId && row.sender === "bot");
      if (!message) throw new HttpError(404, "MESSAGE_NOT_FOUND", "Message not found");
      const log = await repository.insertAiLog({ profileUserId: actor.profileUserId, messages: [{ action: "save_favorite_outfit", message_id: message.message_id, session_id: body.sessionId }], recommendedProducts: message.product_ids });
      return { ok: true, logId: log.log_id };
    },
    async syncFavorites(context, body) {
      const actor = resolveChatActor(context, body);
      if (!actor.profileUserId) throw new HttpError(401, "AUTH_REQUIRED", "Đăng nhập để lưu gợi ý");
      const favorites = Array.isArray(body.favorites) ? body.favorites.slice(0, 50) : [];
      let count = 0;
      for (const raw of favorites) {
        if (!isJsonObject(raw)) throw new HttpError(422, "VALIDATION_ERROR", "Invalid favorite");
        const sessionId = asString(raw.session_id || raw.sessionId);
        await requireOwnedSession(repository, sessionId, actor);
        const message = (await repository.listMessages(sessionId, 300)).rows?.find((row) => row.message_id === (raw.message_id || raw.id) && row.sender === "bot");
        if (!message) throw new HttpError(404, "MESSAGE_NOT_FOUND", "Message not found");
        await repository.insertAiLog({ profileUserId: actor.profileUserId, messages: [{ action: "save_favorite_outfit", message_id: message.message_id, session_id: sessionId }], recommendedProducts: message.product_ids });
        count++;
      }
      return { ok: true, count };
    },
    async listAdminSessions(context, searchParams) {
      requireSupportAdmin(context);
      const status = searchParams.get("handoffStatus");
      const result = await repository.listAdminSessions({ handoffOnly: searchParams.get("handoffOnly") === "true", handoffStatus: status && ["ai", "requested", "assigned", "closed"].includes(status) ? status : undefined, ticketId: searchParams.get("ticketId") || undefined, limit: integer(searchParams.get("limit"), 50, 100), offset: integer(searchParams.get("offset"), 0, 100000) });
      return { ...result, rows: (result.rows || []).map((row) => publicSession(row, true)) };
    },
    async getAdminMessages(context, sessionId) {
      requireSupportAdmin(context); requireUuid(sessionId, "sessionId");
      const session = await repository.getSession(sessionId);
      if (!session) throw new HttpError(404, "CHAT_SESSION_NOT_FOUND", "Chat session not found");
      return transcript(session, true);
    },
    async agentReply(context, sessionId, body) {
      requireSupportAdmin(context); requireUuid(sessionId, "sessionId");
      const result = await repository.staffAction(sessionId, context.profile!.user_id, "reply", { text: boundedText(body.message || body.text, 2000) });
      return { session: publicSession(asJsonObject(result.session), true), message: publicMessage(asJsonObject(result.message), true) };
    },
    async assignSession(context, sessionId, body) {
      requireSupportAdmin(context); requireUuid(sessionId, "sessionId");
      const action = body.status === "closed" ? "close" : "assign";
      const result = await repository.staffAction(sessionId, context.profile!.user_id, action, { outcome: body.outcome || "", correction: body.correction || "" });
      return { session: publicSession(asJsonObject(result.session), true), message: publicMessage(asJsonObject(result.message), true) };
    },
    async reviewSession(context, sessionId, body) {
      requireSupportAdmin(context); requireUuid(sessionId, "sessionId");
      const action = asString(body.action);
      if (!["correction", "outcome", "supervisor", "moderate"].includes(action)) throw new HttpError(422, "VALIDATION_ERROR", "Invalid staff review action");
      const payload: JsonObject = { text: boundedText(body.text, 2000), message_id: body.messageId || null, risk: body.risk || null };
      if (["correction", "moderate"].includes(action)) requireUuid(payload.message_id, "messageId");
      if (action === "moderate" && (!["yellow", "orange", "red"].includes(asString(body.risk)) || body.confirmed !== true)) throw new HttpError(422, "VALIDATION_ERROR", "Confirm the selected moderation risk before hiding content");
      if (action === "correction") {
        const classification = asJsonObject(body.classification);
        const fields: Record<string, readonly string[]> = {
          intent: ["facts", "catalog", "policy_problem", "order", "human"], level: ["L0", "L1", "L2", "L3"],
          issue: ["general", "catalog", "sizing", "delivery", "return", "payment", "cancellation"],
          sentiment: ["positive", "neutral", "negative"], risk: ["green", "yellow", "orange", "red"],
          moderation: ["none", "abuse", "threat", "illegal", "sensitive"]
        };
        if (Object.entries(fields).some(([field, values]) => !values.includes(asString(classification[field])))) throw new HttpError(422, "VALIDATION_ERROR", "Provide a complete staff classification correction");
        payload.classification = Object.fromEntries(Object.keys(fields).map((field) => [field, classification[field]]));
      }
      const result = await repository.staffAction(sessionId, context.profile!.user_id, action, payload);
      return { session: publicSession(asJsonObject(result.session), true), message: publicMessage(asJsonObject(result.message), true) };
    },
    async moderatedOriginal(context, sessionId, messageId) {
      requireSupportAdmin(context); requireUuid(sessionId, "sessionId"); requireUuid(messageId, "messageId");
      if (context.roleCode !== "super_admin") throw new HttpError(403, "SUPERVISOR_REQUIRED", "Supervisor access required");
      return repository.getModeratedOriginal(sessionId, messageId, context.profile!.user_id);
    },
    async approvePolicy(context, policyId, body) {
      requireSupportAdmin(context); requireUuid(policyId, "policyId");
      if (context.roleCode !== "super_admin") throw new HttpError(403, "SUPERVISOR_REQUIRED", "Supervisor approval required");
      const expiry = new Date(asString(body.expiresAt));
      if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now() || expiry.getTime() > Date.now() + 90 * 86400000) throw new HttpError(422, "VALIDATION_ERROR", "Approval must expire within 90 days");
      return repository.approvePolicy(policyId, context.profile!.user_id, expiry.toISOString());
    }
  };
}

/** Guest grants must derive from OTP, not from a checkout capability or an arbitrary phone. */
export function validateChatInput(body: JsonObject = {}): ChatInput {
  const sessionId = asString(body.sessionId || body.session_id), orderId = asString(body.orderId || body.order_id);
  if (sessionId) requireUuid(sessionId, "sessionId");
  if (orderId) requireUuid(orderId, "orderId");
  const attachment = isJsonObject(body.attachment) ? body.attachment : null;
  if (attachment && (!/^image\/(jpeg|png|webp)$/.test(asString(attachment.mimeType)) || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(asString(attachment.data)) || asString(attachment.data).length > 6000000)) throw new HttpError(422, "INVALID_ATTACHMENT", "Use a JPEG, PNG or WebP image under 4 MB");
  return { sessionId, guestId: asString(body.guestId || body.guest_id), message: boundedText(body.message || body.text || (attachment ? "Gửi hình ảnh đính kèm" : ""), 1000), attachment, orderId, guestAccessToken: asString(body.guestAccessToken || body.guest_access_token) };
}

/** Explicit human requests bypass generation entirely. */
export function detectHandoffIntent(message: unknown): boolean {
  const text = asString(message).trim();
  return /^(?:cskh|human|live agent|hotline)$/iu.test(text)
    || /(?:muốn|cần|gặp|nói chuyện|kết nối|chuyển|nối máy|yêu cầu|want|need|speak|talk).{0,60}(?:nhân viên|tu van vien|tư vấn viên|chăm sóc khách hàng|cskh|người thật|human|live agent)/iu.test(text)
    || /(?:tạo|mở|gửi|create|open|submit).{0,25}(?:ticket|phiếu hỗ trợ)/iu.test(text);
}

/** Fresh source snapshots contain no shipping name, phone, address or account identifiers. */
export async function loadSources(repository: ChatbotRepository, analysis: ChatAnalysis, query: string, order: JsonObject | null): Promise<ChatSource[]> {
  const sources: ChatSource[] = [];
  const policies = (await repository.listPolicies()).rows || [];
  const approvals = (await repository.listPolicyApprovals()).rows || [];
  for (const policy of policies) {
    sources.push({ id: `policy:${policy.policy_id}`, kind: "policy", recordId: asString(policy.policy_id), version: asString(policy.updated_at), approved: approvals.some((approval) => approval.policy_id === policy.policy_id && approval.source_updated_at === policy.updated_at), content: JSON.stringify({ title: policy.title, summary: policy.summary, content: policy.content }), snapshot: { updated_at: policy.updated_at } });
  }
  if (analysis.level === "L1") {
    const candidates = (await repository.searchProducts(query, 6)).rows || [];
    const products = (await repository.listProductsByIds(candidates.map((row) => row.product_id))).rows || [];
    for (const product of products.filter((row) => availableVariants(row).length)) sources.push(productSource(product));
  }
  if (analysis.level === "L0") {
    for (const page of (await repository.listOfficialPages()).rows || []) sources.push({ id: `page:${page.static_page_id}`, kind: "page", recordId: asString(page.static_page_id), version: asString(page.updated_at), approved: false, content: JSON.stringify({ title: page.title, content: page.content }), snapshot: { updated_at: page.updated_at } });
  }
  if (order) sources.push({ id: `order:${order.order_id}`, kind: "order", recordId: asString(order.order_id), version: asString(order.updated_at), approved: false, content: JSON.stringify({ order_code: order.order_code, status: order.status, total_amount: order.total_amount, tracking_code: order.tracking_code }), snapshot: { updated_at: order.updated_at } });
  return sources;
}

async function refreshSources(repository: ChatbotRepository, sources: ChatSource[], sessionId: string, actor: ChatActor): Promise<ChatSource[] | null> {
  const products = (await repository.listProductsByIds(sources.filter((source) => source.kind === "product").map((source) => source.recordId))).rows || [];
  const policies = (await repository.listPolicies()).rows || [];
  const pages = sources.some((source) => source.kind === "page") ? (await repository.listOfficialPages()).rows || [] : [];
  const approvals = (await repository.listPolicyApprovals()).rows || [];
  for (const source of sources) {
    const row = source.kind === "product" ? products.find((product) => product.product_id === source.recordId) : source.kind === "policy" ? policies.find((policy) => policy.policy_id === source.recordId) : source.kind === "page" ? pages.find((page) => page.static_page_id === source.recordId) : await repository.readAuthorizedOrder(sessionId, actor, source.recordId);
    if (!row || asString(row.updated_at) !== source.version) return null;
    if (source.kind === "product" && JSON.stringify(productSource(row).snapshot) !== JSON.stringify(source.snapshot)) return null;
    if (source.approved && !approvals.some((approval) => approval.policy_id === source.recordId && approval.source_updated_at === source.version)) return null;
  }
  return sources;
}
function productSource(product: JsonObject): ChatSource {
  const snapshot = { base_price: product.base_price, sale_price: product.sale_price, variants: availableVariants(product) };
  return { id: `product:${product.product_id}`, kind: "product", recordId: asString(product.product_id), version: asString(product.updated_at), approved: false, content: JSON.stringify({ name: product.name, description: asString(product.description).slice(0, 300), ...snapshot }), snapshot };
}
function availableVariants(product: JsonObject): JsonObject[] {
  return (Array.isArray(product.variants) ? product.variants.filter(isJsonObject) : []).filter((variant) => asNumber(variant.stock_quantity) - asNumber(variant.reserved_quantity) > 0).map((variant) => ({ variant_id: variant.variant_id, size: variant.size, color: variant.color, stock_quantity: variant.stock_quantity, reserved_quantity: variant.reserved_quantity })).sort((a, b) => asString(a.variant_id).localeCompare(asString(b.variant_id)));
}
function formatProductCard(product: JsonObject): JsonObject {
  const variant = availableVariants(product)[0] || null;
  return { product_id: product.product_id, name: product.name, image_url: Array.isArray(product.images) ? product.images[0] : "", base_price: product.base_price, sale_price: product.sale_price, price: product.sale_price ?? product.base_price, detail_url: `/products/${product.product_id}`, variant: variant ? { ...variant, stock_quantity: asNumber(variant.stock_quantity) - asNumber(variant.reserved_quantity) } : null };
}
function publicMessage(message: JsonObject, staff = false): JsonObject {
  const metadata = asJsonObject(message.metadata);
  const analysis = asJsonObject(metadata.analysis || metadata.classification);
  const classification = staff && Object.keys(analysis).length ? { intent: analysis.intent, level: analysis.level, issue: analysis.issue, sentiment: analysis.sentiment, risk: analysis.risk, moderation: analysis.moderation } : undefined;
  const hidden = message.moderation_status === "restricted";
  return { ...message, text: hidden ? staff ? "[Nội dung đã được kiểm duyệt — chỉ giám sát được xem bản gốc]" : "[Nội dung được kiểm duyệt]" : message.text, metadata: hidden ? { risk: metadata.risk, moderated: true, ...(staff ? { classification } : {}) } : { system: metadata.system, speaker: metadata.system ? "SYSTEM" : message.sender === "agent" ? "HUMAN" : message.sender === "bot" ? "AI" : "CUSTOMER", attachment: metadata.attachment, product_ids: message.product_ids, agent_name: metadata.agent_name, approach: metadata.approach, source_ids: metadata.source_ids, risk: metadata.risk, otp_required: metadata.otp_required, ...(staff ? { classification } : {}) } };
}
function publicSession(session: JsonObject, staff = false): JsonObject {
  const { metadata, issue_counts: _counts, support_ticket, ...publicFields } = session;
  const meta = asJsonObject(metadata);
  const ticket = asJsonObject(support_ticket);
  const restricted = session.risk_level === "orange" || session.risk_level === "red";
  return { ...publicFields, ...(staff ? { support_ticket } : { support_ticket: support_ticket ? { ticket_id: ticket.ticket_id, status: ticket.status } : null }), metadata: staff ? { handoff_summary: meta.handoff_summary, supervisor_required: meta.supervisor_required } : {}, ...(restricted ? { title: "Cuộc trò chuyện hỗ trợ", last_message_preview: "Cuộc trò chuyện hỗ trợ" } : {}) };
}
function resolveChatActor(context: AuthContext | undefined, input: { guestId?: unknown; guest_id?: unknown }): ChatActor {
  if (context?.profile) {
    if (!context.authUser?.id || context.profile.is_active !== true || context.profile.role === "guest") throw new HttpError(403, "ACCOUNT_ACCESS_DENIED", "Account is not active");
    return { authUserId: context.authUser.id, profileUserId: context.profile.user_id, guestId: null };
  }
  const guestId = asString(input.guestId || input.guest_id); requireUuid(guestId, "guestId");
  return { authUserId: "", profileUserId: "", guestId };
}
async function requireOwnedSession(repository: ChatbotRepository, sessionId: string, actor: ChatActor): Promise<JsonObject> {
  requireUuid(sessionId, "sessionId");
  const session = await repository.getSession(sessionId);
  if (!session || !session.is_active || (actor.profileUserId ? session.profile_user_id !== actor.profileUserId : Boolean(session.profile_user_id) || session.guest_id !== actor.guestId)) throw new HttpError(404, "CHAT_SESSION_NOT_FOUND", "Chat session not found");
  return session;
}
function requireSupportAdmin(context: AuthContext | undefined): asserts context is AuthContext {
  if (!context?.authUser?.id || !context.isAdmin || context.profile?.is_active !== true || !CHAT_SUPPORT_ROLES.includes(context.roleCode)) throw new HttpError(403, "RBAC_DENIED", "Active CSKH staff access required");
}
function humanAnalysis(message: string): ChatAnalysis {
  return { intent: "human", level: "L3", issue: "general", context: { issueKey: "human_request", problem: message, wanted: "Nhân viên CSKH hỗ trợ", failedApproaches: [], compromiseFailed: false, authorityExceeded: false }, sentiment: "neutral", risk: "green", moderation: "none" };
}
function requireUuid(value: unknown, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(asString(value))) throw new HttpError(422, "VALIDATION_ERROR", `${field} must be a UUID`);
}
function boundedText(value: unknown, maximum: number): string {
  const text = asString(value).trim();
  if (!text || text.length > maximum) throw new HttpError(422, "VALIDATION_ERROR", `Text must contain 1–${maximum} characters`);
  return text;
}
function integer(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return value === null || !Number.isFinite(parsed) ? fallback : Math.max(0, Math.min(maximum, Math.trunc(parsed)));
}
