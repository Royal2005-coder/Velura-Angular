import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { runtimeReadiness } from "../../apps/api/src/ops-runtime.js";

const installed = {
  contract: "chatbot-3.1.7", ready: true,
  checks: { governance054: true, session056: true, promotions057: true, reports058: true },
};

for (const scenario of [
  { name: "complete installed metadata contract", payload: installed, status: 200, expected: true },
  { name: "missing schema RPC", payload: { code: "PGRST202" }, status: 404, expected: false },
  { name: "incomplete prerequisite 054", payload: { ...installed, checks: { ...installed.checks, governance054: false } }, status: 200, expected: false },
  { name: "missing continuous context 056", payload: { ...installed, checks: { ...installed.checks, session056: false } }, status: 200, expected: false },
  { name: "missing approved promotions 057", payload: { ...installed, checks: { ...installed.checks, promotions057: false } }, status: 200, expected: false },
  { name: "missing durable reports 058", payload: { ...installed, checks: { ...installed.checks, reports058: false } }, status: 200, expected: false },
  { name: "unversioned success is insufficient", payload: { ready: true }, status: 200, expected: false },
  { name: "unexpected contract version", payload: { ...installed, contract: "unknown" }, status: 200, expected: false },
]) {
  test(`readiness requires ${scenario.name}`, async () => {
    const originalFetch = globalThis.fetch;
    const savedConfig = { ...config };
    const savedEndpoint = process.env.LITELLM_ENDPOINT;
    const savedKey = process.env.LITELLM_API_KEY;
    Object.assign(config, { supabaseUrl: "https://db.example.test", supabaseServiceRoleKey: "service-test" });
    process.env.LITELLM_ENDPOINT = "https://gateway.example.test/v1";
    process.env.LITELLM_API_KEY = "gateway-test";
    const calls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      assert.ok(init?.method === undefined || init.method === "GET", "readiness must not invoke mutation RPCs");
      assert.equal(init?.redirect, "error");
      if (url.pathname === "/rest/v1/rpc/chat_schema_readiness") {
        assert.equal(new Headers(init?.headers).get("apikey"), "service-test");
        return Response.json(scenario.payload, { status: scenario.status });
      }
      if (url.pathname === "/rest/v1/product") assert.equal(url.searchParams.get("limit"), "0");
      return new Response(null, { status: 200 });
    };
    try {
      const result = await runtimeReadiness();
      assert.equal(result.checks.database, true);
      assert.equal(result.checks.gateway, true);
      assert.equal(result.checks.chatbotSchema, scenario.expected);
      assert.equal(result.ready, scenario.expected);
      assert.equal(calls.filter(path => path.startsWith("/rest/v1/rpc/")).length, 1);
    } finally {
      globalThis.fetch = originalFetch;
      Object.assign(config, savedConfig);
      if (savedEndpoint === undefined) delete process.env.LITELLM_ENDPOINT; else process.env.LITELLM_ENDPOINT = savedEndpoint;
      if (savedKey === undefined) delete process.env.LITELLM_API_KEY; else process.env.LITELLM_API_KEY = savedKey;
    }
  });
}

test("readiness cannot use anonymous credentials to certify chatbot governance", async () => {
  const originalFetch = globalThis.fetch;
  const savedConfig = { ...config };
  Object.assign(config, { supabaseUrl: "https://db.example.test", supabaseServiceRoleKey: "", supabaseAnonKey: "anon-test" });
  globalThis.fetch = async input => {
    assert.ok(!String(input).includes("chat_schema_readiness"));
    return new Response(null, { status: 200 });
  };
  try {
    const result = await runtimeReadiness();
    assert.equal(result.checks.chatbotSchema, false);
    assert.equal(result.ready, false);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config, savedConfig);
  }
});
