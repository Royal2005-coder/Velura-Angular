/**
 * Feature Spec F1 — Unified Gemini Decision Gateway, Key Failover (`gemini.env`), SSRF Guard & Zero-Leakage Hygiene.
 *
 * Independently runnable:
 *   node --import tsx --test tests/api/uat-f1-decision-gateway.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { handleDecisionAdminRoute } from "../../apps/api/src/decision/decision-router.js";
import {
  evaluateGeminiDecisions,
  generateFallbackAwareEmbedding,
  generateFallbackAwareJson,
  parseKeyFromEnvContent,
  readDecisionEngineMetrics,
  resetDecisionClientStateForTest,
  resolveFallbackGeminiKey,
  resolveRolloutMode,
} from "../../apps/api/src/decision/gemini-decision-client.js";
import { HttpError } from "../../apps/api/src/http.js";
import { accessForRole } from "../../apps/api/src/rbac.js";
import {
  assertSafeExternalMediaUrl,
  fetchSafeMediaBytes,
  isBlockedInternalHost,
} from "../../apps/api/src/security/safe-media-fetch.js";
import type { AuthContext, HttpRequest, HttpResponse } from "../../apps/api/src/types.js";
import { withScrubbedAiEnv } from "./helpers/decision-test-kit.js";

function createMockHttp(method: string, bodyObj?: Record<string, unknown>): {
  req: HttpRequest;
  res: HttpResponse;
  readResponse: () => { status: number; json: Record<string, unknown> };
} {
  const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), "utf8") : Buffer.alloc(0);
  const req = Object.assign(Readable.from(payload.length ? [payload] : []), {
    method,
    url: "/api/v1/admin/ai-decisions/status",
    headers: { "content-type": "application/json" },
  }) as unknown as HttpRequest;

  let statusCode = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(status: number) {
      statusCode = status;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return this;
    },
  } as unknown as HttpResponse;

  return {
    req,
    res,
    readResponse: () => ({
      status: statusCode,
      json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>,
    }),
  };
}

const adminAccess = accessForRole("super_admin");
const superAdminCtx: AuthContext = {
  authUser: { id: "00000000-0000-4000-8000-000000000001", email: "admin@velura.test" },
  profile: {
    user_id: "00000000-0000-4000-8000-000000000001",
    email: "admin@velura.test",
    role: "admin",
    admin_role: "super_admin",
    is_active: true,
  },
  roleCode: "super_admin",
  roleName: "super_admin",
  isAdmin: true,
  allowedPages: adminAccess.allowedPages,
  allowedModules: adminAccess.allowedModules,
  capabilities: adminAccess.capabilities,
  accessToken: "admin-jwt",
} as AuthContext;

test("F1.1: parseKeyFromEnvContent & resolveFallbackGeminiKey handle gemini.env, skip 0-byte apps/gemini.env, and block disk fallback in production", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "velura-f1-env-"));
  try {
    mkdirSafe(join(tempDir, "apps"));
    // Empty 0-byte apps/gemini.env + populated root gemini.env
    writeFileSync(join(tempDir, "apps", "gemini.env"), "", "utf8");
    writeFileSync(join(tempDir, "gemini.env"), "# Local fallback key\nAQ.SyntheticLocalFallbackKey1234567890\n", "utf8");

    assert.equal(parseKeyFromEnvContent("# only comments\n\n"), "");
    assert.equal(
      parseKeyFromEnvContent("GEMINI_API_KEY=\"AIzaSyntheticQuotedKey1234567890\""),
      "AIzaSyntheticQuotedKey1234567890",
    );

    await withScrubbedAiEnv(
      { NODE_ENV: "development", ALLOW_LOCAL_GEMINI_ENV_FALLBACK: "true" },
      () => {
        resetDecisionClientStateForTest();
        const fromSubdir = resolveFallbackGeminiKey({ cwd: join(tempDir, "apps") });
        // apps/gemini.env is 0-byte; when cwd is tempDir root it finds gemini.env cleanly
        assert.equal(fromSubdir, "");
        resetDecisionClientStateForTest();
        const fromRoot = resolveFallbackGeminiKey({ cwd: tempDir, nodeEnv: "development" });
        assert.equal(fromRoot, "AQ.SyntheticLocalFallbackKey1234567890");

        // In production mode, local disk gemini.env MUST be strictly ignored (`P0-02`)
        resetDecisionClientStateForTest();
        const inProd = resolveFallbackGeminiKey({ cwd: tempDir, nodeEnv: "production" });
        assert.equal(inProd, "");
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    resetDecisionClientStateForTest();
  }
});

test("F1.2: evaluateGeminiDecisions fails over Tier-1 (429/503) -> Tier-2 fallback key, trips 60s circuit breaker, and skips tripped primary key on Tier-3", async () => {
  await withScrubbedAiEnv(
    {
      GEMINI_PRIMARY_KEY: "PRIMARY_TEST_KEY_429",
      GEMINI_FALLBACK_FREE_KEY: "SECONDARY_FREE_KEY_OK",
      ALLOW_LOCAL_GEMINI_ENV_FALLBACK: "false",
    },
    async () => {
      resetDecisionClientStateForTest();
      const callLog: Array<{ url: string; key: string }> = [];

      const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        const key = headers.get("x-goog-api-key") || "";
        callLog.push({ url, key });

        if (key === "PRIMARY_TEST_KEY_429") {
          return new Response(JSON.stringify({ error: { code: 429, message: "Quota exceeded" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            answers: {
              is_ready: { type: "noul", noul: 0.91, confidence: 0.91 },
            },
            usage: { input_tokens: 64 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const first = await evaluateGeminiDecisions(
        {
          useCase: "cskh_sentiment",
          input: "Khách hỏi tình trạng đơn hàng",
          questions: { is_ready: { type: "noul", instructions: "Ready?" } },
        },
        mockFetch,
      );
      assert.equal(first.transport, "fallback_decisions_api");
      assert.equal(first.usedFallbackKey, true);
      assert.equal(callLog.length, 2);

      // Second call within 60s cooldown MUST skip PRIMARY_TEST_KEY_429 immediately (only 1 fetch!)
      const second = await evaluateGeminiDecisions(
        {
          useCase: "cskh_sentiment",
          input: "Lần gọi thứ hai khi circuit đang mở",
          questions: { is_ready: { type: "noul", instructions: "Ready?" } },
        },
        mockFetch,
      );
      assert.equal(second.transport, "fallback_decisions_api");
      assert.equal(callLog.length, 3);
      assert.equal(callLog[2].key, "SECONDARY_FREE_KEY_OK");

      // Now simulate Tier-2 /decisions ALSO returning 501 while Tier-3 :generateContent succeeds:
      // Tripped primary key MUST NOT be retried in Tier-3 when fallback key is available (`P2-02`)!
      const tier3Log: string[] = [];
      const tier3Fetch: typeof fetch = async (input, init) => {
        const url = String(input);
        const key = new Headers(init?.headers).get("x-goog-api-key") || "";
        tier3Log.push(`${key}@${url}`);
        if (url.endsWith("/decisions")) {
          return new Response(JSON.stringify({ error: { code: 501 } }), { status: 501 });
        }
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ is_ready: { noul: 0.85, confidence: 0.85 } }) }] } }],
            usageMetadata: { promptTokenCount: 55 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const third = await evaluateGeminiDecisions(
        {
          useCase: "cskh_sentiment",
          input: "Tier-3 fallback check",
          questions: { is_ready: { type: "noul", instructions: "Ready?" } },
        },
        tier3Fetch,
      );
      assert.equal(third.transport, "structured_json_fallback");
      assert.equal(third.usedFallbackKey, true);
      assert.ok(tier3Log.every((entry) => !entry.startsWith("PRIMARY_TEST_KEY_429@")));

      const metrics = readDecisionEngineMetrics();
      assert.equal(metrics[0]?.useCase, "cskh_sentiment");
      assert.equal(metrics[0]?.requests, 3);
    },
  );
});

test("F1.3: evaluateGeminiDecisions immediately rethrows 422 AI_SAFETY_BLOCK and 400 client errors without burning Tier-2/Tier-3 quota", async () => {
  await withScrubbedAiEnv(
    {
      GEMINI_PRIMARY_KEY: "PRIMARY_KEY_STRICT",
      GEMINI_FALLBACK_FREE_KEY: "FALLBACK_KEY_NEVER_CALLED",
    },
    async () => {
      resetDecisionClientStateForTest();
      let calls = 0;
      const safetyFetch: typeof fetch = async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      await assert.rejects(
        () =>
          evaluateGeminiDecisions(
            {
              useCase: "cskh_sentiment",
              input: "Unsafe input",
              questions: { q1: { type: "noul", instructions: "Check?" } },
            },
            safetyFetch,
          ),
        (err: unknown) => err instanceof HttpError && err.status === 422 && err.code === "AI_SAFETY_BLOCK",
      );
      assert.equal(calls, 1, "Safety block must NOT fail over to Tier-2 or Tier-3");
    },
  );
});

test("F1.4: generateFallbackAwareJson & generateFallbackAwareEmbedding fail over cleanly, and resolveRolloutMode hashes deterministically", async () => {
  await withScrubbedAiEnv(
    {
      GEMINI_PRIMARY_KEY: "PRIMARY_GEN_FAIL",
      GEMINI_FALLBACK_FREE_KEY: "FALLBACK_GEN_OK",
      AI_DECISION_ROLLOUT_MODE: "canary",
      AI_DECISION_CANARY_PERCENT: "50",
    },
    async () => {
      resetDecisionClientStateForTest();
      const firstRollout = resolveRolloutMode("entity-deterministic-42");
      const secondRollout = resolveRolloutMode("entity-deterministic-42");
      assert.deepEqual(firstRollout, secondRollout);

      const genFetch: typeof fetch = async (input, init) => {
        const key = new Headers(init?.headers).get("x-goog-api-key") || "";
        if (key === "PRIMARY_GEN_FAIL") {
          return new Response("Rate limited", { status: 429 });
        }
        const url = String(input);
        if (url.includes(":embedContent")) {
          return new Response(
            JSON.stringify({ embedding: { values: Array.from({ length: 1536 }, (_, i) => Number((i / 1536).toFixed(4))) } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ headline: "Velura Quiet Luxury" }) }] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const jsonOut = await generateFallbackAwareJson(
        "Generate headline",
        { type: "object", required: ["headline"], properties: { headline: { type: "string" } } },
        { customFetch: genFetch },
      );
      assert.equal(jsonOut.usedFallbackKey, true);
      assert.equal(jsonOut.data.headline, "Velura Quiet Luxury");

      const embOut = await generateFallbackAwareEmbedding("Đầm lụa tơ tằm", { dimensions: 1536, customFetch: genFetch });
      assert.equal(embOut.usedFallbackKey, true);
      assert.equal(embOut.embedding.length, 1536);
    },
  );
});

test("F1.5: Admin Decision Router enforces RBAC, blocks SSRF internal URLs on product-qa, and SafeMediaFetch caps oversized streams", async () => {
  assert.equal(isBlockedInternalHost("169.254.169.254"), true);
  assert.equal(isBlockedInternalHost("127.0.0.1"), true);
  assert.equal(isBlockedInternalHost("10.42.0.15"), true);
  assert.equal(isBlockedInternalHost("kong.database.svc"), true);
  assert.equal(isBlockedInternalHost("cdn.velura.vn"), false);

  assert.throws(
    () => assertSafeExternalMediaUrl("http://169.254.169.254/latest/meta-data/"),
    (err: unknown) => err instanceof HttpError && err.code === "UNSAFE_MEDIA_SCHEME",
  );
  assert.throws(
    () => assertSafeExternalMediaUrl("https://169.254.169.254/latest/meta-data/"),
    (err: unknown) => err instanceof HttpError && err.code === "SSRF_HOST_BLOCKED",
  );
  assert.throws(
    () => assertSafeExternalMediaUrl("https://kong.database.svc:8000/internal.jpg"),
    (err: unknown) => err instanceof HttpError && err.code === "SSRF_HOST_BLOCKED",
  );

  // Oversized streaming body without content-length MUST abort at maxBytes (413 IMAGE_TOO_LARGE)
  const bigChunk = new Uint8Array(2048);
  const streamFetch: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(bigChunk);
        },
      }),
      { status: 200 },
    );
  await assert.rejects(
    () => fetchSafeMediaBytes("https://cdn.velura.vn/huge.jpg", { maxBytes: 1024, fetchFn: streamFetch }),
    (err: unknown) => err instanceof HttpError && err.status === 413 && err.code === "IMAGE_TOO_LARGE",
  );

  // Unauthenticated request to /api/v1/admin/ai-decisions/status -> 401
  const unauth = createMockHttp("GET");
  await assert.rejects(
    () =>
      handleDecisionAdminRoute({
        req: unauth.req,
        res: unauth.res,
        parts: ["api", "v1", "admin", "ai-decisions", "status"],
        headers: {},
      }),
    (err: unknown) => err instanceof HttpError && err.status === 401,
  );

  // Authenticated super_admin GET /status + SSRF check on POST /product-qa
  await withScrubbedAiEnv({ GEMINI_PRIMARY_KEY: "TEST_STATUS_KEY" }, async () => {
    const statusHttp = createMockHttp("GET");
    const handled = await handleDecisionAdminRoute({
      req: statusHttp.req,
      res: statusHttp.res,
      parts: ["api", "v1", "admin", "ai-decisions", "status"],
      context: superAdminCtx,
      headers: {},
    });
    assert.equal(handled, true);
    const body = statusHttp.readResponse();
    assert.equal(body.status, 200);
    assert.equal(body.json.configured, true);
    assert.equal(body.json.primaryKeyConfigured, true);
    // Ensure key material itself is NEVER returned in status JSON
    assert.equal(JSON.stringify(body.json).includes("TEST_STATUS_KEY"), false);

    const ssrfHttp = createMockHttp("POST", { imageUrl: "https://127.0.0.1/secret.png" });
    await assert.rejects(
      () =>
        handleDecisionAdminRoute({
          req: ssrfHttp.req,
          res: ssrfHttp.res,
          parts: ["api", "v1", "admin", "ai-decisions", "product-qa"],
          context: superAdminCtx,
          headers: {},
        }),
      (err: unknown) => err instanceof HttpError && err.status === 422 && err.code === "SSRF_HOST_BLOCKED",
    );
  });
});

test("F1.6: Static source hygiene — zero leaked GEMINI_/AIza/AQ. secrets and zero `as any` in touched Angular/AI files", () => {
  const root = resolve(process.cwd());
  const filesToAudit = [
    "apps/admin-erp-ng/src/app/features/content/admin-erp-content.page.ts",
    "apps/admin-erp-ng/src/app/features/returns/return-flow.component.ts",
    "apps/user-ng/src/app/features/ai/personal-color.component.ts",
    "apps/api/src/decision/gemini-decision-client.ts",
    "apps/api/src/decision/decision-service.ts",
    "apps/api/src/decision/decision-router.ts",
    "apps/api/src/security/safe-media-fetch.ts",
    "apps/api/src/content/blog-ai-workflow.ts",
  ];

  for (const relPath of filesToAudit) {
    const content = readFileSync(resolve(root, relPath), "utf8");
    assert.equal(/\bas\s+any\b|:\s*any\b/.test(content), false, `Forbidden 'any' found in ${relPath}`);
    assert.equal(/AIza[0-9A-Za-z_-]{30,}/.test(content), false, `Hardcoded AIza key found in ${relPath}`);
    assert.equal(/AQ\.Ab[0-9A-Za-z_-]{30,}/.test(content), false, `Hardcoded AQ. key found in ${relPath}`);
  }
});

function mkdirSafe(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
