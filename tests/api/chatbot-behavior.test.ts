import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { signJwt } from "../../apps/api/src/auth-helper.js";
import { HttpError } from "../../apps/api/src/http.js";
import { config } from "../../apps/api/src/config.js";
import { asJsonObject, asString, isJsonObject, type AuthContext, type JsonObject } from "../../apps/api/src/types.js";
import { createChatbotRepository, type ChatbotRepository } from "../../apps/api/src/chatbot/chatbot-repository.js";
import { createChatbotService } from "../../apps/api/src/chatbot/chatbot-service.js";
import { parseChatAnalysis, parseChatDraft } from "../../apps/api/src/chatbot/llm-service.js";
import type { ChatAnalysis, ChatDraft, ChatModel } from "../../apps/api/src/chatbot/chatbot-types.js";

const SESSION = "22222222-2222-4222-8222-222222222222";
const GUEST = "11111111-1111-4111-8111-111111111111";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const ORDER = "44444444-4444-4444-8444-444444444444";
const POLICY = "55555555-5555-4555-8555-555555555555";
const PRODUCT = "66666666-6666-4666-8666-666666666666";
const VERSION = "2026-10-08T00:00:00.000Z";
const POLICY_RULE = "Yêu cầu đổi trả được gửi trong 48 giờ sau khi giao thành công.";

function principal(role = "member", active = true): AuthContext {
  return { authUser: { id: MEMBER }, profile: { user_id: MEMBER, role: role === "member" ? "member" : "admin", admin_role: role, is_active: active }, roleCode: role, roleName: role, isAdmin: role !== "member", allowedPages: [], allowedModules: [], accessToken: "" };
}

function analysis(overrides: Partial<ChatAnalysis> = {}): ChatAnalysis {
  const context = overrides.context || { issueKey: "return_deadline", problem: "Thời hạn đổi trả", wanted: "Biết thời hạn gửi yêu cầu", failedApproaches: [], compromiseFailed: false, authorityExceeded: false };
  return { intent: "facts", level: "L0", issue: "return", sentiment: "neutral", risk: "green", moderation: "none", confidence: 0.9, reasons: ["request_identified"], ...overrides, context, filtered: overrides.filtered || { text: "Khách cần hỗ trợ về chính sách đổi trả", problem: context.problem, wanted: context.wanted, failedApproaches: context.failedApproaches } };
}

function draft(overrides: Partial<ChatDraft> = {}): ChatDraft {
  return { text: POLICY_RULE, productIds: [], claims: [{ sourceId: `policy:${POLICY}`, quote: POLICY_RULE }], approach: "official_policy", promisedActions: [], ...overrides };
}

function rows(value: unknown, field = "messages"): JsonObject[] {
  assert.ok(isJsonObject(value));
  const result = value[field];
  assert.ok(Array.isArray(result));
  assert.ok(result.every(isJsonObject));
  return result;
}

function session(value: unknown): JsonObject {
  assert.ok(isJsonObject(value));
  assert.ok(isJsonObject(value.session));
  return value.session;
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// The repository fixture implements publication/ownership transactions, not model output.
// These tests exercise the service; real PostgreSQL lock behavior remains a staging gate.
function fixture(modelOverrides: Partial<ChatModel> = {}) {
  const state = {
    session: { session_id: SESSION, guest_id: GUEST, profile_user_id: null, is_active: true, handoff_status: "ai", ai_epoch: 0, ai_failures: 0, risk_level: "green", metadata: {} } as JsonObject,
    messages: [] as JsonObject[],
    policies: [{ policy_id: POLICY, slug: "returns", title: "Đổi trả", summary: POLICY_RULE, content: [{ items: [POLICY_RULE] }], display_order: 1, updated_at: VERSION }],
    approvals: [] as JsonObject[],
    products: [{ product_id: PRODUCT, name: "Đầm công sở", base_price: 700000, sale_price: 650000, updated_at: VERSION, status: "on_sale", variants: [{ variant_id: "77777777-7777-4777-8777-777777777777", size: "M", color: "Đen", stock_quantity: 3, reserved_quantity: 1 }] }] as JsonObject[],
    order: { order_id: ORDER, order_code: "VLR001", user_id: MEMBER, status: "delivered", total_amount: 650000, shipping_phone: "0901234567", shipping_address: "Địa chỉ riêng", updated_at: VERSION } as JsonObject,
    grants: new Set<string>(),
    originals: new Map<string, JsonObject>(),
    issueCounts: new Map<string, number>(),
    analyzed: new Set<string>(),
    failed: new Set<string>(),
    handoffReasons: [] as string[],
    summaries: [] as JsonObject[],
    reviews: [] as { action: string; payload: JsonObject }[],
    tickets: new Set<string>(),
    reports: [] as { sessionId: string; event: string }[],
    failures: new Map<string, number>(),
    l2Attempts: new Map<string, number>(),
    modelCalls: 0,
    reviewCalls: 0,
    originalReads: 0
  };
  function append(sender: string, text: string, metadata: JsonObject = {}, productIds: unknown[] = []) {
    const participant = sender === "user" || sender === "agent";
    const message: JsonObject = { message_id: randomUUID(), session_id: SESSION, sender, text: participant ? "[Đang lọc nội dung]" : text, metadata: participant ? { filter_verified: false } : metadata, product_ids: productIds, sequence: state.messages.length + 1, moderation_status: participant ? "pending" : "visible" };
    if (participant) state.originals.set(asString(message.message_id), { text, metadata });
    state.messages.push(message);
    return { ...message };
  }
  const repository: ChatbotRepository = {
    ...createChatbotRepository(),
    getSession: async () => ({ ...state.session }),
    createSession: async (input) => {
      state.session = { ...state.session, profile_user_id: input.profileUserId || null, guest_id: input.guestId || null, title: input.title };
      return { ...state.session };
    },
    insertMessage: async (input) => append(input.sender, input.text, input.metadata, input.productIds),
    listMessages: async (_id, limit = 100) => ({ rows: state.messages.slice(-limit).map((row) => ({ ...row })), count: state.messages.length }),
    listSessions: async () => ({ rows: [{ ...state.session }], count: 1 }),
    listAdminSessions: async () => ({ rows: [{ ...state.session }], count: 1 }),
    listProductsByIds: async (ids) => ({ rows: state.products.filter((product) => Array.isArray(ids) && ids.includes(product.product_id)), count: state.products.length }),
    searchProducts: async () => ({ rows: state.products, count: state.products.length }),
    listPolicies: async () => ({ rows: state.policies, count: state.policies.length }),
    listPolicyApprovals: async () => ({ rows: state.approvals, count: state.approvals.length }),
    listOfficialPages: async () => ({ rows: [], count: 0 }),
    appendUserTurn: async (_id, _actor, text, metadata) => ({ session: { ...state.session }, message: append("user", text, metadata), epoch: state.session.ai_epoch }),
    recordAnalysis: async (_id, messageId, key, value, failed) => {
      if (failed) {
        if (!state.failed.has(messageId)) { state.failed.add(messageId); state.session.ai_failures = Number(state.session.ai_failures) + 1; state.failures.set(key, (state.failures.get(key) || 0) + 1); }
        return { session: { ...state.session }, ai_failures: state.session.ai_failures, issue_failures: state.failures.get(key) };
      }
      if (!state.analyzed.has(messageId)) {
        state.analyzed.add(messageId);
        state.issueCounts.set(key, (state.issueCounts.get(key) || 0) + 1);
        state.session.risk_level = value.risk;
        const message = state.messages.find((row) => row.message_id === messageId)!;
        message.text = asJsonObject(value.filtered).text;
        message.metadata = { classification: Object.fromEntries(Object.entries(value).filter(([field]) => !["context", "filtered"].includes(field))), risk: value.risk, filter_verified: true, issue_key: key };
        message.moderation_status = value.moderation !== "none" ? "restricted" : "visible";
        const safe = asJsonObject(value.filtered);
        state.session.metadata = { ...asJsonObject(state.session.metadata), handoff_summary: { problem: safe.problem, wanted: safe.wanted, failed_approaches: safe.failedApproaches }, supervisor_required: value.risk === "red" };
      }
      return { session: { ...state.session }, occurrences: state.issueCounts.get(key), ai_failures: state.session.ai_failures, l2_attempts: state.l2Attempts.get(key) || 0 };
    },
    commitAiTurn: async (_id, epoch, sequence, value) => {
      const latest = state.messages.filter((row) => row.sender === "user").at(-1);
      if (state.session.handoff_status !== "ai" || state.session.ai_epoch !== epoch || latest?.sequence !== sequence) return { sent: false, reason: "HUMAN_OR_NEWER_TURN", session: { ...state.session } };
      if (latest?.moderation_status === "pending") return { sent: false, reason: "FILTER_PENDING", session: { ...state.session } };
      const message = append("bot", asString(value.text), asJsonObject(value.metadata), Array.isArray(value.product_ids) ? value.product_ids : []);
      if (!asJsonObject(value.metadata).model_failure) state.session.ai_failures = 0;
      if (asJsonObject(value.metadata).level === "L2") {
        const key = asString(asJsonObject(value.metadata).issue_key);
        state.l2Attempts.set(key, (state.l2Attempts.get(key) || 0) + 1);
      }
      return { sent: true, message, session: { ...state.session } };
    },
    handoff: async (_id, _actor, summary, reason, supervisor) => {
      state.handoffReasons.push(reason);
      state.summaries.push(summary);
      if (!state.session.support_ticket_id) { state.session.support_ticket_id = randomUUID(); state.tickets.add(asString(state.session.support_ticket_id)); }
      if (state.session.handoff_status === "ai") {
        state.session.handoff_status = "requested";
        state.session.ai_epoch = Number(state.session.ai_epoch) + 1;
        append("bot", "Yêu cầu đã chuyển đến CSKH.", { system: true, handoff: true });
      }
      state.session.metadata = { ...asJsonObject(state.session.metadata), supervisor_required: supervisor || asJsonObject(state.session.metadata).supervisor_required };
      return { session: { ...state.session }, ticket_id: state.session.support_ticket_id };
    },
    staffAction: async (_id, _actorId, action, payload) => {
      if (["correction", "outcome", "supervisor", "moderate"].includes(action)) state.reviews.push({ action, payload });
      if (action === "reply" || action === "assign") {
        state.session.handoff_status = "assigned";
        state.session.ai_epoch = Number(state.session.ai_epoch) + 1;
      }
      return { session: { ...state.session }, message: action === "reply" ? append("agent", asString(payload.text), { speaker: "HUMAN" }) : {} };
    },
    grantOrder: async (_id, _guest, orderId) => { state.grants.add(orderId); },
    readAuthorizedOrder: async (_id, actor, orderId) => {
      if (orderId !== state.order.order_id || (actor.profileUserId ? actor.profileUserId !== state.order.user_id : !state.grants.has(orderId))) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found");
      return { ...state.order };
    },
    getModeratedOriginal: async (_id, messageId) => { state.originalReads++; const original = state.originals.get(messageId); return original ? { original_text: original.text, original_metadata: original.metadata } : {}; }
  };
  const model: ChatModel = {
    analyze: async () => { state.modelCalls++; return analysis(); },
    draft: async () => draft(),
    review: async () => { state.reviewCalls++; return { safe: true, reasons: [] }; },
    ...modelOverrides
  };
  const service = createChatbotService({ repository, model, integrations: {
    enqueueReport: async (sessionId, event) => { state.reports.push({ sessionId, event }); },
    eligibleOffers: async () => [],
    confirmOffer: async () => { throw new Error("No eligible offer configured in fixture"); },
    retryReport: async () => { throw new Error("No report retry configured in fixture"); }
  } });
  return { state, service, repository, model, send: (message: string, extra: JsonObject = {}, context?: AuthContext) => service.sendMessage(context, { sessionId: SESSION, guestId: GUEST, message, ...extra }) };
}


test("a guest cannot read or append to another guest's session", async () => {
  const f = fixture();
  await assert.rejects(() => f.send("Chính sách đổi trả", { guestId: MEMBER }), (error: unknown) => error instanceof HttpError && error.status === 404);
  assert.equal(f.state.messages.length, 0);
  assert.equal(f.state.modelCalls, 0);
});

test("an authenticated member cannot adopt a guest or another member's session", async () => {
  const f = fixture();
  await assert.rejects(() => f.send("Chính sách đổi trả", {}, principal()), (error: unknown) => error instanceof HttpError && error.code === "CHAT_SESSION_NOT_FOUND");
  f.state.session.profile_user_id = ORDER;
  f.state.session.guest_id = null;
  await assert.rejects(() => f.send("Chính sách đổi trả", {}, principal()), (error: unknown) => error instanceof HttpError && error.status === 404);
  assert.equal(f.state.messages.length, 0);
});

test("member order disclosure requires ownership before any generation or message append", async () => {
  const f = fixture();
  f.state.session.profile_user_id = MEMBER;
  f.state.session.guest_id = null;
  f.state.order.user_id = GUEST;
  await assert.rejects(() => f.send("Trạng thái đơn của tôi", { orderId: ORDER }, principal()), (error: unknown) => error instanceof HttpError && error.code === "ORDER_NOT_FOUND");
  assert.equal(f.state.messages.length, 0);
  assert.equal(f.state.modelCalls, 0);
});

test("guest order disclosure rejects missing, wrong-purpose, wrong-order and expired OTP credentials", async () => {
  for (const token of ["", signJwt({ purpose: "checkout", verified_order_id: ORDER, phone: "0901234567", otp_challenge_id: POLICY }), signJwt({ purpose: "guest_order_session", verified_order_id: POLICY, phone: "0901234567", otp_challenge_id: POLICY }), signJwt({ purpose: "guest_order_session", verified_order_id: ORDER, phone: "0901234567", otp_challenge_id: POLICY }, -1)]) {
    const f = fixture();
    await assert.rejects(() => f.send("Trạng thái đơn", { orderId: ORDER, guestAccessToken: token }), (error: unknown) => error instanceof HttpError && [401, 404].includes(error.status));
    assert.equal(f.state.grants.size, 0);
    assert.equal(f.state.messages.length, 0);
  }
});

test("verified order facts reach generation without the OTP, phone or shipping address", async () => {
  const f = fixture({
    analyze: async () => analysis({ intent: "order", issue: "delivery" }),
    draft: async (_message, history, _analysis, sources) => {
      const privateData = JSON.stringify({ history, sources });
      assert.ok(!privateData.includes("0901234567"));
      assert.ok(!privateData.includes("Địa chỉ riêng"));
      assert.ok(!privateData.includes("guest_order_session"));
      return draft({ text: "Đơn hàng đã giao thành công.", claims: [{ sourceId: `order:${ORDER}`, quote: "delivered" }] });
    }
  });
  const token = signJwt({ purpose: "guest_order_session", verified_order_id: ORDER, phone: "0901234567", otp_challenge_id: POLICY });
  const result = await f.send("Trạng thái đơn", { orderId: ORDER, guestAccessToken: token });
  assert.equal(rows(result).filter((message) => message.sender === "bot").length, 1);
  assert.equal(session(result).handoff_status, "ai");
  assert.ok(!JSON.stringify(result).includes(token));
});

test("an order code written into chat cannot replace selected-order authentication", async () => {
  const f = fixture({ analyze: async () => analysis({ intent: "order", issue: "delivery" }) });
  const result = await f.send("Tra cứu VLR001, số điện thoại 0901234567");
  assert.equal(f.state.grants.size, 0);
  assert.equal(f.state.reviewCalls, 0);
  assert.equal(asJsonObject(rows(result).at(-1)?.metadata).otp_required, true);
});

test("direct human requests bypass unavailable AI and repeated handoff creates one ticket", async () => {
  const f = fixture({ analyze: async () => { throw new Error("must not generate"); } });
  const responses = await Promise.all([f.send("Mình muốn gặp CSKH"), f.send("Tạo ticket hỗ trợ giúp tôi")]);
  assert.equal(f.state.tickets.size, 1);
  assert.equal(f.state.messages.filter((message) => asJsonObject(message.metadata).system && message.sender === "bot").length, 1);
  assert.ok(responses.every((result) => session(result).handoff_status === "requested"));
});

test("a policy complaint remains AI-resolvable and does not imply a direct human request", async () => {
  const f = fixture();
  const result = await f.send("Quy trình khiếu nại và phản ánh về đổi trả là gì?");
  assert.equal(session(result).handoff_status, "ai");
  assert.equal(f.state.tickets.size, 0);
  assert.equal(f.state.reviewCalls, 1);
});

test("a third sizing issue escalates instead of repeating catalog advice", async () => {
  const f = fixture({ analyze: async () => analysis({ intent: "catalog", level: "L1", issue: "sizing" }) });
  await f.send("Size M chưa phù hợp, tư vấn lại giúp tôi");
  await f.send("Size M vẫn chưa phù hợp, tư vấn lại giúp tôi");
  const result = await f.send("Size M vẫn chưa phù hợp lần thứ ba");
  assert.equal(session(result).handoff_status, "requested");
  assert.equal(f.state.reviewCalls, 2);
});

test("failed compromise and requests beyond authority escalate without drafting a transaction", async () => {
  for (const field of ["compromiseFailed", "authorityExceeded"] as const) {
    const base = analysis();
    const f = fixture({ analyze: async () => analysis({ context: { ...base.context, [field]: true } }), draft: async () => { throw new Error("must not draft"); } });
    const result = await f.send("Tôi cần giải quyết vấn đề đổi trả này");
    assert.equal(session(result).handoff_status, "requested");
    assert.equal(f.state.reviewCalls, 0);
  }
});

test("L2 requires every cited resolution policy to be explicitly approved", async () => {
  const f = fixture({ analyze: async () => analysis({ intent: "policy_problem", level: "L2" }) });
  let result = await f.send("Hướng dẫn xử lý đổi trả trong chính sách");
  assert.equal(session(result).handoff_status, "requested");
  assert.equal(f.state.reviewCalls, 0);
  const approved = fixture({ analyze: async () => analysis({ intent: "policy_problem", level: "L2" }) });
  approved.state.approvals.push({ policy_id: POLICY, source_updated_at: VERSION });
  result = await approved.send("Hướng dẫn xử lý đổi trả trong chính sách");
  assert.equal(session(result).handoff_status, "ai");
  assert.equal(approved.state.reviewCalls, 1);
  const secondPolicy = "88888888-8888-4888-8888-888888888888";
  approved.state.policies.push({ ...approved.state.policies[0], policy_id: secondPolicy });
  approved.model.draft = async () => draft({ claims: [{ sourceId: `policy:${POLICY}`, quote: POLICY_RULE }, { sourceId: `policy:${secondPolicy}`, quote: POLICY_RULE }] });
  result = await approved.send("Cần áp dụng thêm chính sách thứ hai");
  assert.equal(session(result).handoff_status, "requested");
  assert.equal(approved.state.reviewCalls, 1);
});

test("official policy passages after the old truncation limit and eighth policy remain retrievable", async () => {
  const f = fixture({ draft: async () => draft({ claims: [{ sourceId: `policy:${POLICY}`, quote: "Quy định cuối cùng đã được công bố." }] }) });
  f.state.policies[0].summary = "A".repeat(2400);
  f.state.policies[0].content = [{ items: ["Quy định cuối cùng đã được công bố."] }];
  f.state.policies.unshift(...Array.from({ length: 8 }, (_, index) => ({ ...f.state.policies[0], policy_id: randomUUID(), display_order: index })));
  const result = await f.send("Quy định cuối cùng của chính sách là gì?");
  assert.equal(session(result).handoff_status, "ai");
  assert.equal(f.state.reviewCalls, 1);
});

test("invented benefits, refund/order promises and recycled failed approaches are never published", async () => {
  const forbidden: Partial<ChatDraft>[] = [
    { promisedActions: ["issue_voucher"] },
    { text: "Tôi sẽ hoàn tiền cho bạn ngay." },
    { text: "Mình sẽ hủy đơn cho bạn." },
    { text: "Mã voucher VELURA100 dành cho bạn." },
    { approach: "try_again" }
  ];
  for (const reply of forbidden) {
    const base = analysis();
    const f = fixture({ analyze: async () => analysis({ context: { ...base.context, failedApproaches: ["try_again"] } }), draft: async () => draft(reply) });
    const result = await f.send("Vấn đề thanh toán chưa được xử lý");
    assert.equal(session(result).handoff_status, "requested");
    assert.equal(f.state.reviewCalls, 0);
    assert.equal(rows(result).filter((message) => message.sender === "bot" && !asJsonObject(message.metadata).system).length, 0);
  }
});

test("independent risk rejection prevents publication even when declared citations pass", async () => {
  const f = fixture({ review: async () => ({ safe: false, reasons: ["UNSUPPORTED_TEXT_FACT"] }) });
  const result = await f.send("Chính sách đổi trả");
  assert.equal(session(result).handoff_status, "requested");
  assert.equal(rows(result).filter((message) => message.sender === "bot" && !asJsonObject(message.metadata).system).length, 0);
});

test("prices and variants are freshly loaded and depleted products are not recommended", async () => {
  const f = fixture({
    analyze: async () => analysis({ intent: "catalog", level: "L1", issue: "catalog" }),
    draft: async (_message, _history, _analysis, sources) => {
      const source = sources.find((item) => item.kind === "product");
      assert.ok(source);
      assert.equal(source.snapshot.sale_price, 650000);
      assert.equal(asJsonObject((source.snapshot.variants as unknown[])[0]).stock_quantity, 3);
      return draft({ productIds: [PRODUCT], claims: [{ sourceId: source.id, quote: "650000" }] });
    }
  });
  const result = await f.send("Gợi ý đầm công sở");
  assert.equal(rows(result, "products")[0].price, 650000);
  assert.equal(asJsonObject(rows(result, "products")[0].variant).stock_quantity, 2);
  const empty = fixture({ analyze: async () => analysis({ intent: "catalog", level: "L1", issue: "catalog" }), draft: async () => draft({ productIds: [PRODUCT] }) });
  empty.state.products[0].variants = [{ variant_id: POLICY, stock_quantity: 1, reserved_quantity: 1 }];
  const rejected = await empty.send("Gợi ý đầm công sở");
  assert.equal(rows(rejected, "products").length, 0);
  assert.equal(session(rejected).handoff_status, "requested");
});

test("a price, variant stock, policy-version or approval change prevents a stale answer", async () => {
  for (const change of ["price", "stock", "policy", "approval"] as const) {
    const f = fixture({
      analyze: async () => analysis({ intent: change === "price" || change === "stock" ? "catalog" : "policy_problem", level: change === "price" || change === "stock" ? "L1" : "L2" }),
      draft: async () => {
        if (change === "price") f.state.products[0].sale_price = 600000;
        if (change === "stock") asJsonObject((f.state.products[0].variants as unknown[])[0]).reserved_quantity = 3;
        if (change === "policy") f.state.policies[0].updated_at = "2026-10-08T01:00:00.000Z";
        if (change === "approval") f.state.approvals.length = 0;
        return draft({ productIds: change === "price" || change === "stock" ? [PRODUCT] : [] });
      }
    });
    f.state.approvals.push({ policy_id: POLICY, source_updated_at: VERSION });
    const result = await f.send("Hỗ trợ yêu cầu này");
    assert.equal(session(result).handoff_status, "requested");
    assert.equal(f.state.reviewCalls, 0);
    assert.equal(rows(result).filter((message) => message.sender === "bot" && !asJsonObject(message.metadata).system).length, 0);
  }
});

test("human takeover atomically suppresses an already reviewed late AI response", async () => {
  const started = deferred(), release = deferred();
  const f = fixture({ review: async () => { started.release(); await release.promise; return { safe: true, reasons: [] }; } });
  const pending = f.send("Chính sách đổi trả");
  await started.promise;
  await f.service.agentReply(principal("admin_operator_cskh_dt"), SESSION, { text: "Nhân viên đang hỗ trợ bạn." });
  release.release();
  const result = await pending;
  assert.equal(session(result).handoff_status, "assigned");
  assert.equal(rows(result).filter((message) => message.sender === "agent").length, 1);
  assert.equal(rows(result).filter((message) => message.sender === "bot").length, 0);
});

test("a newer user turn suppresses an older AI response without dropping either user message", async () => {
  const started = deferred(), release = deferred();
  let reviews = 0;
  const f = fixture({ review: async () => { if (++reviews === 1) { started.release(); await release.promise; } return { safe: true, reasons: [] }; } });
  const older = f.send("Chính sách đổi trả");
  await started.promise;
  await f.send("Chi tiết chính sách đổi trả");
  release.release();
  const result = await older;
  assert.equal(rows(result).filter((message) => message.sender === "user").length, 2);
  assert.equal(rows(result).filter((message) => message.sender === "bot").length, 1);
});

test("negative sentiment alone cannot moderate a message or lock an account", async () => {
  for (const risk of ["orange", "red"] as const) {
    const f = fixture({ analyze: async () => analysis({ sentiment: "negative", risk, moderation: "none" }) });
    const result = await f.send("Tôi rất không hài lòng về dịch vụ");
    assert.equal(session(result).handoff_status, "ai");
    assert.equal(session(result).risk_level, "yellow");
    assert.equal(session(result).is_active, true);
    assert.equal(f.state.originals.size, 1);
    assert.equal(rows(result)[0].moderation_status, "visible");
  }
});

test("severe content is private, escalates to supervisor and never automatically locks the account", async () => {
  const original = "Nội dung nghiêm trọng riêng tư";
  const base = analysis();
  const f = fixture({ analyze: async () => analysis({ risk: "red", moderation: "threat", context: { ...base.context, problem: original, wanted: original, failedApproaches: [original] }, filtered: { text: "Khách cần hỗ trợ giải quyết dịch vụ", problem: "Yêu cầu giải quyết dịch vụ", wanted: "Nhân viên hỗ trợ", failedApproaches: [] } }) });
  const result = await f.send(original);
  assert.equal(session(result).handoff_status, "requested");
  assert.equal(session(result).is_active, true);
  assert.equal(f.state.originals.size, 1);
  assert.ok(!JSON.stringify(result).includes(original));
  assert.ok(!JSON.stringify(f.state.summaries).includes(original));
  const staff = await f.service.getAdminMessages(principal("admin_operator_cskh_dt"), SESSION, new URLSearchParams());
  assert.ok(!JSON.stringify(staff).includes(original));
  const messageId = asString(rows(result)[0].message_id);
  await assert.rejects(() => f.service.moderatedOriginal(principal("admin_operator_cskh_dt"), SESSION, messageId), (error: unknown) => error instanceof HttpError && error.code === "SUPERVISOR_REQUIRED");
  assert.equal(f.state.originalReads, 0);
  const privileged = await f.service.moderatedOriginal(principal("super_admin"), SESSION, messageId);
  assert.equal(asJsonObject(privileged).original_text, original);
  assert.equal(f.state.originalReads, 1);
});

test("inactive staff and non-CSKH admins cannot mutate or access moderated originals", async () => {
  const f = fixture();
  for (const actor of [principal("super_admin", false), principal("admin_content"), principal()]) {
    await assert.rejects(() => f.service.agentReply(actor, SESSION, { text: "Không được ghi" }), (error: unknown) => error instanceof HttpError && error.status === 403);
    await assert.rejects(() => f.service.moderatedOriginal(actor, SESSION, POLICY), (error: unknown) => error instanceof HttpError && error.status === 403);
  }
  assert.equal(f.state.messages.length, 0);
  assert.equal(f.state.originalReads, 0);
});

test("malformed or unavailable classifiers have finite failure and then human escalation", async () => {
  for (const analyze of [async () => parseChatAnalysis({ intent: "facts" }), async () => { throw new Error("provider unavailable"); }]) {
    const f = fixture({ analyze });
    const first = await f.send("Chính sách đổi trả");
    assert.equal(session(first).handoff_status, "ai");
    assert.equal(rows(first).filter((message) => message.sender === "bot").length, 0);
    const second = await f.send("Vẫn cần biết chính sách đổi trả");
    assert.equal(session(second).handoff_status, "requested");
    assert.equal(f.state.tickets.size, 1);
    assert.ok(f.state.handoffReasons.includes("REPEATED_MODEL_FAILURE"));
  }
});

test("malformed drafts and unavailable risk reviewers hand off without publishing a draft", async () => {
  for (const overrides of [{ draft: async () => parseChatDraft({ text: "Tôi sẽ hoàn tiền" }) }, { review: async () => { throw new Error("review unavailable"); } }]) {
    const f = fixture(overrides);
    const result = await f.send("Chính sách đổi trả");
    assert.equal(session(result).handoff_status, "requested");
    assert.equal(rows(result).filter((message) => message.sender === "bot" && !asJsonObject(message.metadata).system).length, 0);
  }
});

test("classification correction requires confirmation and supervisor original access", async () => {
  const f = fixture();
  const message = await f.repository.insertMessage({ sessionId: SESSION, sender: "user", text: "Phản ánh dịch vụ" });
  await assert.rejects(() => f.service.reviewSession(principal("super_admin"), SESSION, { action: "correction", messageId: message.message_id, text: "Đánh giá lại", classification: analysis() }), (error: unknown) => error instanceof HttpError && error.status === 422);
  await assert.rejects(() => f.service.reviewSession(principal("admin_operator_cskh_dt"), SESSION, { action: "correction", messageId: message.message_id, text: "Đánh giá lại", classification: analysis(), confirmed: true }), (error: unknown) => error instanceof HttpError && error.status === 403);
  assert.equal(f.state.originalReads, 0);
  assert.equal(f.state.reviews.length, 0);
});

test("manual moderation requires confirmation and cannot expose a restricted original in its response", async () => {
  const f = fixture();
  const original = "Nội dung riêng tư phải được ẩn";
  const message = await f.repository.insertMessage({ sessionId: SESSION, sender: "user", text: original });
  await assert.rejects(() => f.service.reviewSession(principal("admin_operator_cskh_dt"), SESSION, { action: "moderate", messageId: message.message_id, text: "Cần kiểm duyệt", risk: "orange" }), (error: unknown) => error instanceof HttpError && error.status === 422);
  assert.equal(f.state.reviews.length, 0);
  const result = await f.service.reviewSession(principal("admin_operator_cskh_dt"), SESSION, { action: "moderate", messageId: message.message_id, text: "Cần kiểm duyệt", risk: "orange", confirmed: true });
  assert.ok(!JSON.stringify(result).includes(original));
});

test("distinct catalog questions do not count as repeats of the same underlying issue", async () => {
  let request = 0;
  const base = analysis();
  const f = fixture({ analyze: async () => analysis({ intent: "catalog", issue: "catalog", level: "L1", context: { ...base.context, issueKey: ["office_outfit", "party_outfit", "travel_outfit"][request++] } }) });
  await f.send("Tôi cần gợi ý trang phục đi làm");
  await f.send("Tôi cần gợi ý trang phục dự tiệc");
  const result = await f.send("Tôi cần gợi ý trang phục du lịch");
  assert.equal(session(result).handoff_status, "ai");
  assert.equal(f.state.tickets.size, 0);
  assert.equal(f.state.reviewCalls, 3);
});

test("concurrent staff reads never expose an unfiltered pending turn", async () => {
  const entered = deferred(), release = deferred();
  const raw = "Private raw customer request";
  const f = fixture({ analyze: async () => { entered.release(); await release.promise; return analysis(); } });
  const send = f.send(raw, { attachment: null });
  await entered.promise;
  const pending = await f.service.getAdminMessages(principal("admin_operator_cskh_dt"), SESSION, new URLSearchParams());
  assert.equal(rows(pending)[0].moderation_status, "pending");
  assert.ok(!JSON.stringify(pending).includes(raw));
  release.release();
  const ready = await send;
  assert.equal(rows(ready)[0].moderation_status, "visible");
  assert.ok(!JSON.stringify(ready).includes(raw));
});

test("filter outages after takeover preserve quarantine without an AI failure reply", async () => {
  const f = fixture({ analyze: async () => { throw new Error("filter unavailable"); } });
  f.state.session.handoff_status = "assigned";
  const raw = "Unfiltered text sent while a human handles support";
  const result = await f.send(raw);
  assert.equal(session(result).handoff_status, "assigned");
  assert.equal(rows(result)[0].moderation_status, "pending");
  assert.equal(rows(result).filter((message) => message.sender === "bot").length, 0);
  assert.ok(!JSON.stringify(result).includes(raw));
  assert.ok(f.state.reports.some((report) => report.event === "warning"));
});

test("L2 gets exactly one additional approved attempt, then hands off without another reply", async () => {
  let turns = 0;
  const base = analysis();
  const f = fixture({ analyze: async () => analysis({ level: "L2", intent: "policy_problem", context: { ...base.context, compromiseFailed: ++turns > 1 } }), draft: async () => draft({ approach: `approved_approach_${turns}` }) });
  f.state.approvals.push({ policy_id: POLICY, source_updated_at: VERSION });
  await f.send("Cần hỗ trợ đổi trả");
  const second = await f.send("Phương án trước chưa giải quyết được vấn đề");
  assert.equal(session(second).handoff_status, "ai");
  assert.equal(rows(second).filter((message) => message.sender === "bot").length, 2);
  const final = await f.send("Phương án bổ sung vẫn không giải quyết được");
  assert.equal(session(final).handoff_status, "requested");
  assert.equal(rows(final).filter((message) => message.sender === "bot" && !asJsonObject(message.metadata).system).length, 2);
});

test("explicit compromise rejection cannot evade the attempt state by changing the model issue label", async () => {
  let turns = 0;
  const base = analysis();
  const f = fixture({ analyze: async () => analysis({ level: "L2", intent: "policy_problem", context: { ...base.context, issueKey: ++turns === 1 ? "exchange" : "unrelated_model_label" } }) });
  f.state.approvals.push({ policy_id: POLICY, source_updated_at: VERSION });
  await f.send("Tư vấn phương án đổi hàng");
  const rejected = await f.send("Tôi không đồng ý");
  assert.equal(session(rejected).handoff_status, "requested");
  assert.equal(rows(rejected).filter((message) => message.sender === "bot" && !asJsonObject(message.metadata).system).length, 1);
});

test("database denials and missing governance RPCs never downgrade to direct table writes", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = config.supabaseUrl;
  const originalKey = config.supabaseServiceRoleKey;
  config.supabaseUrl = "https://governance.test";
  config.supabaseServiceRoleKey = "service-test";
  const calls: string[] = [];
  try {
    for (const denial of [{ status: 403, code: "PT403", message: "RBAC_DENIED" }, { status: 404, code: "PGRST202", message: "Function not found" }]) {
      globalThis.fetch = async input => {
        calls.push(new URL(String(input)).pathname);
        return new Response(JSON.stringify({ code: denial.code, message: denial.message }), { status: denial.status });
      };
      const repository = createChatbotRepository();
      const actor = { authUserId: "", profileUserId: "", guestId: GUEST };
      for (const operation of [
        () => repository.appendUserTurn(SESSION, actor, "private request", {}),
        () => repository.commitAiTurn(SESSION, 0, 1, { text: "unapproved reply" }, []),
        () => repository.recordAnalysis(SESSION, POLICY, "return", analysis() as unknown as JsonObject, false),
        () => repository.handoff(SESSION, actor, {}, "HUMAN_REQUEST", false),
        () => repository.staffAction(SESSION, MEMBER, "assign", {})
      ]) await assert.rejects(operation, error => error instanceof HttpError);
    }
    assert.equal(calls.length, 10);
    assert.ok(calls.every(path => path.includes("/rpc/")));
  } finally {
    globalThis.fetch = originalFetch;
    config.supabaseUrl = originalUrl;
    config.supabaseServiceRoleKey = originalKey;
  }
});
