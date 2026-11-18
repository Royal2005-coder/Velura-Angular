/**
 * Feature Spec F3 — CSKH Chatbot & Review Sentiment Decision Router (`POSITIVE` / `NEUTRAL` / `NEGATIVE`).
 *
 * Independently runnable:
 *   node --import tsx --test tests/api/uat-f3-cskh-and-reviews.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createLLMService } from "../../apps/api/src/chatbot/llm-service.js";
import { UnifiedDecisionService, redactCustomerPii } from "../../apps/api/src/decision/decision-service.js";
import type { CreateDecisionRequest } from "../../apps/api/src/decision/decision-types.js";
import { accessForRole } from "../../apps/api/src/rbac.js";
import type { ReviewRepository } from "../../apps/api/src/reviews/review-repository.js";
import { createReviewService } from "../../apps/api/src/reviews/review-service.js";
import type { AuthContext } from "../../apps/api/src/types.js";
import { choice, mockDecisionResult, noul, score, withScrubbedAiEnv } from "./helpers/decision-test-kit.js";

const SENTIMENTS = ["POSITIVE", "NEUTRAL", "NEGATIVE"] as const;
const INTENTS = ["PRAISE", "INQUIRY", "COMPLAINT", "RETURN_REQ"] as const;

test("F3.1: redactCustomerPii masks phone numbers, emails, and OTP codes before external Decision API dispatch", async () => {
  const rawMessage = "SĐT của tôi là 0912345678, email lan.nguyen@gmail.com, mã OTP: 482910 bị lỗi giao hàng!";
  const scrubbed = redactCustomerPii(rawMessage);
  assert.equal(scrubbed.includes("0912345678"), false);
  assert.equal(scrubbed.includes("lan.nguyen@gmail.com"), false);
  assert.equal(scrubbed.includes("482910"), false);
  assert.ok(scrubbed.includes("[PHONE_REDACTED]"));
  assert.ok(scrubbed.includes("[EMAIL_REDACTED]"));
  assert.ok(scrubbed.includes("[OTP_REDACTED]"));

  let capturedPayload = "";
  const svc = new UnifiedDecisionService(async (req: CreateDecisionRequest) => {
    capturedPayload = typeof req.input === "string" ? req.input : JSON.stringify(req.input);
    return mockDecisionResult({
      sentiment: choice("NEGATIVE", SENTIMENTS, 0.92),
      intent: choice("COMPLAINT", INTENTS, 0.90),
      urgency: score(1.8, 3, 0.88),
      escalate_threat_or_human: noul(0.20),
    });
  });

  await svc.decideCskhSentiment({
    message: rawMessage,
    history: [{ sender: "user", text: "Gọi gấp số 0988777666 nhé" }],
    contextKind: "chat",
  });
  assert.equal(capturedPayload.includes("0912345678"), false);
  assert.equal(capturedPayload.includes("0988777666"), false);
  assert.equal(capturedPayload.includes("lan.nguyen@gmail.com"), false);
});

test("F3.2: decideCskhSentiment routes POSITIVE/NEUTRAL/NEGATIVE branches, clamps sarcastic 1–2 star reviews to NEGATIVE, and escalates >= 0.60 threat to CRITICAL", async () => {
  // 1. POSITIVE -> NURTURE_AND_UPSELL
  const posSvc = new UnifiedDecisionService(async () =>
    mockDecisionResult({
      sentiment: choice("POSITIVE", SENTIMENTS, 0.94),
      intent: choice("PRAISE", INTENTS, 0.92),
      urgency: score(0.2, 3, 0.90),
      escalate_threat_or_human: noul(0.02),
    }),
  );
  const pos = await posSvc.decideCskhSentiment({ message: "Đầm lụa mặc siêu tôn dáng, rất ưng ý!" });
  assert.equal(pos.sentiment, "POSITIVE");
  assert.equal(pos.routing_branch, "NURTURE_AND_UPSELL");
  assert.equal(pos.escalate_to_human, false);

  // 2. NEUTRAL -> EDUCATE_AND_LOYALTY_HOOK
  const neuSvc = new UnifiedDecisionService(async () =>
    mockDecisionResult({
      sentiment: choice("NEUTRAL", SENTIMENTS, 0.89),
      intent: choice("INQUIRY", INTENTS, 0.91),
      urgency: score(0.5, 3, 0.88),
      escalate_threat_or_human: noul(0.05),
    }),
  );
  const neu = await neuSvc.decideCskhSentiment({ message: "Shop cho mình hỏi chính sách đổi size trong mấy ngày ạ?" });
  assert.equal(neu.sentiment, "NEUTRAL");
  assert.equal(neu.routing_branch, "EDUCATE_AND_LOYALTY_HOOK");

  // 3. Long sarcastic 1-star AND 2-star reviews (> 100 chars) where VLM guessed POSITIVE -> MUST clamp unconditionally to NEGATIVE (`P0-06`)
  const sarcasticReview =
    "Wow dịch vụ giao hàng của shop thật sự quá tuyệt vời luôn đó nha, đặt đầm đi tiệc thứ Bảy mà thứ Tư tuần sau mới thèm giao tới nơi, hộp thì móp méo hết trơn, cảm ơn shop rất nhiều nhé!";
  assert.ok(sarcasticReview.length > 120);
  const clamped1Star = await posSvc.decideCskhSentiment({
    message: sarcasticReview,
    rating: 1,
    contextKind: "review",
  });
  assert.equal(clamped1Star.sentiment, "NEGATIVE");
  assert.equal(clamped1Star.routing_branch, "STANDARDIZED_DEESCALATION");
  assert.ok(clamped1Star.response_guidelines.some((g) => g.includes("KHÔNG chào bán thêm")));

  const clamped2Star = await posSvc.decideCskhSentiment({
    message: sarcasticReview,
    rating: 2,
    contextKind: "review",
  });
  assert.equal(clamped2Star.sentiment, "NEGATIVE");
  assert.equal(clamped2Star.routing_branch, "STANDARDIZED_DEESCALATION");

  // 4. Boundary escalation `[0.60, 0.65)` -> BOTH escalate_to_human === true AND urgency === "CRITICAL" (`P1-03`)
  const boundarySvc = new UnifiedDecisionService(async () =>
    mockDecisionResult({
      sentiment: choice("NEGATIVE", SENTIMENTS, 0.91),
      intent: choice("COMPLAINT", INTENTS, 0.88),
      urgency: score(0.9, 3, 0.86),
      escalate_threat_or_human: noul(0.62),
    }),
  );
  const critical = await boundarySvc.decideCskhSentiment({
    message: "Cho tôi gặp quản lý ngay lập tức, tôi không muốn nói chuyện với bot nữa!",
    contextKind: "chat",
  });
  assert.equal(critical.escalate_to_human, true);
  assert.equal(critical.urgency, "CRITICAL");
});

test("F3.3: createLLMService escalates CRITICAL chat turns to L3 and blocks product upselling on NEGATIVE sentiment", async () => {
  await withScrubbedAiEnv({ AI_DECISION_ROLLOUT_MODE: "active" }, async () => {
    const llm = createLLMService({
      isDecisionConfigured: () => true,
      decisionService: {
        decideCskhSentiment: async () => ({
          sentiment: "NEGATIVE",
          routing_branch: "STANDARDIZED_DEESCALATION",
          intent: "COMPLAINT",
          urgency: "CRITICAL",
          escalate_to_human: true,
          confidence_score: 0.93,
          requires_human_review: false,
          sentiment_probabilities: { POSITIVE: 0.02, NEUTRAL: 0.05, NEGATIVE: 0.93 },
          response_guidelines: ["Xin lỗi chuẩn mực", "Tuyệt đối KHÔNG chào bán thêm"],
        }),
      },
      requestChat: async (_provider, _model, stage) => {
        if (stage === "analysis") {
          return {
            value: {
              intent: "catalog",
              level: "L1",
              issue: "delivery",
              context: {
                issueKey: "late-order-1",
                problem: "Giao hàng trễ",
                wanted: "Gặp nhân viên hỗ trợ",
                failedApproaches: [],
                compromiseFailed: false,
                authorityExceeded: false,
                repeatCount: 1,
                escalationTrend: "rising",
                rejectedApproach: false,
              },
              sentiment: "neutral",
              emotion: { state: "angry", confidence: 0.9, reasons: ["late_delivery"] },
              risk: "green",
              riskAssessment: { confidence: 0.9, reasons: [] },
              moderation: "none",
              filtered: { text: "Giao hàng trễ quá cho gặp nhân viên", problem: "Giao trễ", wanted: "Gặp nhân viên", failedApproaches: [] },
              confidence: 0.88,
              reasons: ["initial"],
            },
            trace: { stage: "analysis", provider: "mistral", model: "mistral-small", durationMs: 5, outcome: "ok" },
          };
        }
        return {
          value: { safe: true, reasons: [] },
          trace: { stage: "response_review", provider: "gemini", model: "gemini-3.5-flash", durationMs: 5, outcome: "ok" },
        };
      },
    });

    const analysis = await llm.analyze("Giao hàng trễ quá cho gặp nhân viên!", []);
    assert.equal(analysis.sentiment, "negative");
    assert.equal(analysis.risk, "yellow");
    assert.equal(analysis.intent, "policy_problem");
    assert.equal(analysis.level, "L3", "escalate_to_human MUST force L3 human handoff");

    // Verify responseRiskCheck deterministically rejects any product upsell (`productIds.length > 0`) when sentiment is negative
    const l1NegAnalysis = { ...analysis, level: "L1" as const };
    const riskVerdict = await llm.review(
      "Giao trễ",
      l1NegAnalysis,
      {
        text: "Dạ Velura xin lỗi bạn ạ.",
        productIds: ["prod-upsell-forbidden"],
        claims: [],
        approach: "apology",
        promisedActions: [],
        trace: [],
      },
      [{ id: "prod-upsell-forbidden", recordId: "prod-upsell-forbidden", kind: "product", title: "Đầm Lụa", content: "Đầm Lụa", approved: true, updatedAt: new Date().toISOString() }],
    );
    assert.equal(riskVerdict.safe, false);
    assert.ok(riskVerdict.reasons.includes("UNRELATED_RECOMMENDATION"));
  });
});

test("F3.4: createReviewService.suggestReply injects branch guidelines in active mode and omits branch override in shadow mode", async () => {
  const reviewAccess = accessForRole("admin_operator_danhgia_review");
  const reviewCtx: AuthContext = {
    authUser: { id: "cskh-1", email: "cskh@velura.test" },
    profile: { user_id: "cskh-1", email: "cskh@velura.test", role: "admin", admin_role: "admin_operator_danhgia_review", is_active: true },
    roleCode: "admin_operator_danhgia_review",
    roleName: "admin_operator_danhgia_review",
    isAdmin: true,
    allowedPages: reviewAccess.allowedPages,
    allowedModules: reviewAccess.allowedModules,
    capabilities: reviewAccess.capabilities,
    accessToken: "cskh-token",
  } as AuthContext;

  const capturedPrompts: string[] = [];
  const repo: ReviewRepository = {
    list: async () => ({ rows: [], count: 0 }),
    get: async (id) => ({
      review_id: id,
      rating: 1,
      comment: "Đường chỉ may bị bung ngay lần mặc đầu tiên!",
      product: { name: "Áo Blazer Lụa Velura" },
    }),
    approve: async () => ({}),
    hide: async () => ({}),
    reply: async () => ({}),
    escalate: async () => ({}),
    listAuditLogs: async () => ({ rows: [], count: 0 }),
  };

  const reviewSvc = createReviewService({
    repository: repo,
    deps: {
      isGeminiConfiguredFn: () => true,
      isDecisionConfigured: () => true,
      decisionService: {
        decideCskhSentiment: async (input) => {
          assert.equal(input.rating, 1);
          assert.equal(input.message, "Đường chỉ may bị bung ngay lần mặc đầu tiên!");
          return {
            sentiment: "NEGATIVE",
            routing_branch: "STANDARDIZED_DEESCALATION",
            intent: "COMPLAINT",
            urgency: "MEDIUM",
            escalate_to_human: false,
            confidence_score: 0.95,
            requires_human_review: false,
            sentiment_probabilities: { POSITIVE: 0.01, NEUTRAL: 0.04, NEGATIVE: 0.95 },
            response_guidelines: ["Xin lỗi chân thành và hướng dẫn đổi mới miễn phí."],
          };
        },
      },
      generateText: async (prompt) => {
        capturedPrompts.push(prompt);
        return JSON.stringify({
          replies: [
            "Velura thành thật xin lỗi bạn về trải nghiệm với Áo Blazer Lụa Velura và xin phép hỗ trợ đổi sản phẩm mới ngay ạ.",
            "Cảm ơn bạn đã phản hồi, bộ phận CSKH Velura xin liên hệ kiểm tra và đổi mới cho bạn trong hôm nay ạ.",
          ],
        });
      },
    },
  });

  await withScrubbedAiEnv({ AI_DECISION_ROLLOUT_MODE: "active" }, async () => {
    const out = await reviewSvc.suggestReply(reviewCtx, "review-neg-1");
    assert.equal(out.source, "gemini");
    assert.equal(out.replies.length, 2);
    assert.ok(capturedPrompts[0]?.includes("STANDARDIZED_DEESCALATION"));
  });

  await withScrubbedAiEnv({ AI_DECISION_ROLLOUT_MODE: "shadow" }, async () => {
    await reviewSvc.suggestReply(reviewCtx, "review-neg-1");
    assert.equal(capturedPrompts[1]?.includes("STANDARDIZED_DEESCALATION"), false);
  });
});
