import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateGeminiDecisions,
  parseKeyFromEnvContent,
  readDecisionEngineMetrics,
  resetDecisionClientStateForTest,
  resolveRolloutMode,
} from "../../apps/api/src/decision/gemini-decision-client.js";
import { runtimeMetrics } from "../../apps/api/src/ops-runtime.js";
import { runGoldenEvaluationSuite } from "../../scripts/eval-decision-golden.mjs";

test("parseKeyFromEnvContent handles both KEY=VALUE and single-line raw gemini.env keys without leaking comments", () => {
  assert.equal(
    parseKeyFromEnvContent("# comment\nGEMINI_FALLBACK_FREE_KEY = \"AIzaSyTestPrimaryKey1234567890\" \n"),
    "AIzaSyTestPrimaryKey1234567890",
  );
  assert.equal(
    parseKeyFromEnvContent("# Raw key format\nAQ.Ab8RN6TestRawSingleLineKey0123456789ABCDEF\n"),
    "AQ.Ab8RN6TestRawSingleLineKey0123456789ABCDEF",
  );
  assert.equal(parseKeyFromEnvContent("# only comments\nshort\n"), "");
});

test("evaluateGeminiDecisions fails over from Primary 429/503 to Secondary Fallback Key and opens circuit breaker", async () => {
  resetDecisionClientStateForTest();
  const prevPrimary = process.env.GEMINI_PRIMARY_KEY;
  const prevFallback = process.env.GEMINI_FALLBACK_FREE_KEY;
  process.env.GEMINI_PRIMARY_KEY = "PRIMARY_QUOTA_EXHAUSTED_KEY_123456";
  process.env.GEMINI_FALLBACK_FREE_KEY = "FALLBACK_FREE_TIER_KEY_987654321";

  const seenHeaders: string[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const apiKey = headers.get("x-goog-api-key") || "";
    seenHeaders.push(`${url}|${apiKey}`);

    if (apiKey === "PRIMARY_QUOTA_EXHAUSTED_KEY_123456") {
      return new Response(JSON.stringify({ error: { code: 429, message: "Resource exhausted" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        answers: {
          is_valid: { type: "noul", noul: 0.94 },
          sentiment: {
            type: "choice",
            choice: "POSITIVE",
            confidence: 0.91,
            probabilities: { POSITIVE: 0.91, NEUTRAL: 0.07, NEGATIVE: 0.02 },
          },
        },
        usage_metadata: { prompt_token_count: 142, total_output_tokens: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    // First call hits Primary -> gets 429 -> trips circuit -> succeeds via Secondary Fallback Key!
    const first = await evaluateGeminiDecisions(
      {
        useCase: "cskh_sentiment",
        input: "Đầm đẹp lắm shop ơi!",
        questions: {
          is_valid: { type: "noul", instructions: "Is message valid?" },
          sentiment: {
            type: "choice",
            instructions: "Classify sentiment",
            criteria: { POSITIVE: "Happy", NEUTRAL: "Neutral", NEGATIVE: "Unhappy" },
          },
        },
      },
      mockFetch,
    );

    assert.equal(first.transport, "fallback_decisions_api");
    assert.equal(first.usedFallbackKey, true);
    assert.equal(seenHeaders.length, 2);

    // Second call within cooldown skips Primary immediately and goes straight to Secondary!
    const second = await evaluateGeminiDecisions(
      {
        useCase: "cskh_sentiment",
        input: "Cảm ơn shop nhiều!",
        questions: {
          is_valid: { type: "noul", instructions: "Is message valid?" },
          sentiment: {
            type: "choice",
            instructions: "Classify sentiment",
            criteria: { POSITIVE: "Happy", NEUTRAL: "Neutral", NEGATIVE: "Unhappy" },
          },
        },
      },
      mockFetch,
    );

    assert.equal(second.usedFallbackKey, true);
    assert.equal(seenHeaders.length, 3);

    const metrics = readDecisionEngineMetrics();
    const cskhMetric = metrics.find((m) => m.useCase === "cskh_sentiment");
    assert.ok(cskhMetric);
    assert.equal(cskhMetric.requests, 2);
    assert.equal(cskhMetric.fallbackKeyCount, 2);

    // Verify Prometheus `/metrics` renders `velura_ai_decision_*` series without exposing any secret key
    const promText = runtimeMetrics();
    assert.match(promText, /velura_ai_decision_requests_total\{use_case="cskh_sentiment"\} 2/);
    assert.match(promText, /velura_ai_decision_fallback_key_total\{use_case="cskh_sentiment"\} 2/);
    assert.ok(!promText.includes("PRIMARY_QUOTA_EXHAUSTED_KEY"));
    assert.ok(!promText.includes("FALLBACK_FREE_TIER_KEY"));
  } finally {
    if (prevPrimary === undefined) delete process.env.GEMINI_PRIMARY_KEY;
    else process.env.GEMINI_PRIMARY_KEY = prevPrimary;
    if (prevFallback === undefined) delete process.env.GEMINI_FALLBACK_FREE_KEY;
    else process.env.GEMINI_FALLBACK_FREE_KEY = prevFallback;
    resetDecisionClientStateForTest();
  }
});

test("evaluateGeminiDecisions falls back to Tier-3 temperature=0.0 Structured JSON when /v1beta/decisions returns 404/501", async () => {
  resetDecisionClientStateForTest();
  const prevPrimary = process.env.GEMINI_PRIMARY_KEY;
  const prevFallback = process.env.GEMINI_FALLBACK_FREE_KEY;
  const prevLocal = process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK;
  process.env.GEMINI_PRIMARY_KEY = "STRUCTURED_FALLBACK_TEST_KEY_123456";
  process.env.GEMINI_FALLBACK_FREE_KEY = "";
  process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK = "false";

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/decisions")) {
      return new Response(JSON.stringify({ error: { code: 503, message: "Decisions endpoint unavailable" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    // Tier 3 generateContent Structured Output response
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    hero_ready: { noul: 0.88, confidence: 0.9 },
                    verdict: { choice: "APPROVED_HERO", confidence: 0.9 },
                    sharpness: { score: 3.8, confidence: 0.89 },
                  }),
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 210 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const result = await evaluateGeminiDecisions(
      {
        useCase: "product_image_qa",
        input: "Test product image metadata",
        questions: {
          hero_ready: { type: "noul", instructions: "Is hero ready?" },
          verdict: {
            type: "choice",
            instructions: "Select verdict",
            criteria: { APPROVED_HERO: "Hero", REJECTED: "Rejected" },
          },
          sharpness: {
            type: "score",
            instructions: "Rate sharpness",
            criteria: ["1", "2", "3", "4", "5"],
          },
        },
      },
      mockFetch,
    );

    assert.equal(result.transport, "structured_json_fallback");
    assert.equal(result.answers.hero_ready.type, "noul");
    assert.equal(result.answers.verdict.type, "choice");
    if (result.answers.verdict.type === "choice") {
      assert.equal(result.answers.verdict.choice, "APPROVED_HERO");
    }
  } finally {
    if (prevPrimary === undefined) delete process.env.GEMINI_PRIMARY_KEY;
    else process.env.GEMINI_PRIMARY_KEY = prevPrimary;
    if (prevFallback === undefined) delete process.env.GEMINI_FALLBACK_FREE_KEY;
    else process.env.GEMINI_FALLBACK_FREE_KEY = prevFallback;
    if (prevLocal === undefined) delete process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK;
    else process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK = prevLocal;
    resetDecisionClientStateForTest();
  }
});

test("resolveRolloutMode supports shadow, canary deterministic bucketing, and active modes", () => {
  const prevMode = process.env.AI_DECISION_ROLLOUT_MODE;
  const prevPct = process.env.AI_DECISION_CANARY_PERCENT;
  try {
    process.env.AI_DECISION_ROLLOUT_MODE = "shadow";
    assert.deepEqual(resolveRolloutMode("session-1"), { mode: "shadow", activeForRequest: false });

    process.env.AI_DECISION_ROLLOUT_MODE = "canary";
    process.env.AI_DECISION_CANARY_PERCENT = "0";
    assert.deepEqual(resolveRolloutMode("session-1"), { mode: "canary", activeForRequest: false });

    process.env.AI_DECISION_CANARY_PERCENT = "100";
    assert.deepEqual(resolveRolloutMode("session-1"), { mode: "canary", activeForRequest: true });

    process.env.AI_DECISION_ROLLOUT_MODE = "active";
    assert.deepEqual(resolveRolloutMode("session-1"), { mode: "active", activeForRequest: true });
  } finally {
    if (prevMode === undefined) delete process.env.AI_DECISION_ROLLOUT_MODE;
    else process.env.AI_DECISION_ROLLOUT_MODE = prevMode;
    if (prevPct === undefined) delete process.env.AI_DECISION_CANARY_PERCENT;
    else process.env.AI_DECISION_CANARY_PERCENT = prevPct;
  }
});

test("50-case Scientific Golden Dataset achieves >= 90% accuracy across all 5 Decision Engine domains", async () => {
  const summary = await runGoldenEvaluationSuite();
  assert.equal(summary.totalCount, 50);
  assert.equal(summary.opticsValid, true, "CIE L*a*b* ITA° optics must separate LIGHT_TONE (>28°) and DARK_TONE (<28°)");
  assert.ok(
    summary.accuracy >= 0.9,
    `Golden Dataset accuracy ${(summary.accuracy * 100).toFixed(1)}% fell below mandatory 90% CI gate. Failed: ${JSON.stringify(summary.failedCases)}`,
  );
  assert.equal(summary.failedCases.length, 0);
});
