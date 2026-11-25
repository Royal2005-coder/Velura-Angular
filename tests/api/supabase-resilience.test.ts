import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import {
  getActiveSupabaseEndpoint,
  resetSupabaseCircuitForTest,
  supabaseRequest
} from "../../apps/api/src/supabase.js";

function withMockedSupabase(
  mockFetch: typeof fetch,
  run: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const prevUrl = config.supabaseUrl;
  const prevAnon = config.supabaseAnonKey;
  const prevService = config.supabaseServiceRoleKey;
  const prevFallbackUrl = config.supabaseFallbackUrl;
  const prevFallbackAnon = config.supabaseFallbackAnonKey;
  const prevFallbackService = config.supabaseFallbackServiceRoleKey;

  config.supabaseUrl = "https://primary.supabase.test";
  config.supabaseAnonKey = "primary-anon-key";
  config.supabaseServiceRoleKey = "primary-service-key";
  config.supabaseFallbackUrl = "http://kong.database.svc:8000";
  config.supabaseFallbackAnonKey = "fallback-anon-key";
  config.supabaseFallbackServiceRoleKey = "fallback-service-key";
  resetSupabaseCircuitForTest();
  globalThis.fetch = mockFetch;

  return run().finally(() => {
    globalThis.fetch = originalFetch;
    config.supabaseUrl = prevUrl;
    config.supabaseAnonKey = prevAnon;
    config.supabaseServiceRoleKey = prevService;
    config.supabaseFallbackUrl = prevFallbackUrl;
    config.supabaseFallbackAnonKey = prevFallbackAnon;
    config.supabaseFallbackServiceRoleKey = prevFallbackService;
    resetSupabaseCircuitForTest();
  });
}

test("supabaseRequest retries transient GET network blip without tripping circuit breaker", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;

  await withMockedSupabase(
    (async (input) => {
      const url = String(input);
      if (url.startsWith("https://primary.supabase.test")) {
        primaryCalls++;
        if (primaryCalls === 1) {
          const err = new TypeError("fetch failed") as TypeError & { cause?: unknown };
          err.cause = Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
          throw err;
        }
        return new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      fallbackCalls++;
      throw new Error("Fallback should not be called on single transient read blip");
    }) as typeof fetch,
    async () => {
      const res = await supabaseRequest("/rest/v1/category", { method: "GET" });
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, [{ id: 1 }]);
      assert.equal(primaryCalls, 2);
      assert.equal(fallbackCalls, 0);
      assert.equal(getActiveSupabaseEndpoint().isFallback, false);
    }
  );
});

test("supabaseRequest NEVER latches circuit OPEN when fallback is unreachable (ECONNREFUSED)", async () => {
  let primaryShouldFail = true;
  let fallbackAttempts = 0;

  await withMockedSupabase(
    (async (input) => {
      const url = String(input);
      if (url.startsWith("https://primary.supabase.test")) {
        if (primaryShouldFail) {
          throw new TypeError("fetch failed");
        }
        return new Response(JSON.stringify([{ ok: true }]), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      fallbackAttempts++;
      const err = new TypeError("fetch failed") as TypeError & { cause?: unknown };
      err.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      throw err;
    }) as typeof fetch,
    async () => {
      // Three consecutive primary write failures cross the threshold and probe fallback.
      for (let i = 0; i < 3; i++) {
        await assert.rejects(
          () => supabaseRequest("/rest/v1/orders", { method: "POST", body: { id: i } }),
          (err: unknown) => (err as { code?: string }).code === "SUPABASE_NETWORK_ERROR"
        );
      }
      assert.equal(fallbackAttempts, 1, "Fallback should be probed once when threshold is reached");
      // Because fallback failed with ECONNREFUSED, circuit MUST remain CLOSED!
      assert.equal(getActiveSupabaseEndpoint().isFallback, false);

      // As soon as primary recovers, the very next request succeeds on primary immediately.
      primaryShouldFail = false;
      const recovered = await supabaseRequest("/rest/v1/category", { method: "GET" });
      assert.equal(recovered.status, 200);
      assert.deepEqual(recovered.data, [{ ok: true }]);
    }
  );
});

test("supabaseRequest latches circuit OPEN when primary returns 402 and fallback responds healthy, then self-heals if fallback dies", async () => {
  let fallbackHealthy = true;
  let primaryStatus = 402;

  await withMockedSupabase(
    (async (input) => {
      const url = String(input);
      if (url.startsWith("https://primary.supabase.test")) {
        if (primaryStatus === 402) {
          return new Response(JSON.stringify({ message: "exceed_egress_quota" }), { status: 402 });
        }
        return new Response(JSON.stringify([{ source: "primary" }]), { status: 200 });
      }
      if (fallbackHealthy) {
        return new Response(JSON.stringify([{ source: "fallback" }]), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "bad gateway" }), { status: 502 });
    }) as typeof fetch,
    async () => {
      // Primary 402 -> fails over to healthy fallback and latches OPEN.
      const res1 = await supabaseRequest("/rest/v1/category", { method: "GET" });
      assert.deepEqual(res1.data, [{ source: "fallback" }]);
      assert.equal(getActiveSupabaseEndpoint().isFallback, true);

      // Next request while fallback is healthy uses fallback directly.
      const res2 = await supabaseRequest("/rest/v1/category", { method: "GET" });
      assert.deepEqual(res2.data, [{ source: "fallback" }]);

      // If fallback later returns 502 while primary recovered, circuit closes and succeeds on primary.
      fallbackHealthy = false;
      primaryStatus = 200;
      const res3 = await supabaseRequest("/rest/v1/category", { method: "GET" });
      assert.deepEqual(res3.data, [{ source: "primary" }]);
      assert.equal(getActiveSupabaseEndpoint().isFallback, false);
    }
  );
});
