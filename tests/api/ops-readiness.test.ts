import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { config } from "../../apps/api/src/config.js";
import { handleRuntimeRoute, runtimeReadiness } from "../../apps/api/src/ops-runtime.js";

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

test("a configured release SHA cannot certify an image without baked release identity", async () => {
  const nativeFetch = globalThis.fetch;
  const savedConfig = { ...config };
  const keys = ["LITELLM_ENDPOINT", "LITELLM_API_KEY", "PRODUCTION_VERIFY_TOKEN", "RELEASE_REVISION", "RELEASE_BUILD_ID"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(config, { supabaseUrl: "https://stageproject.supabase.co", supabaseServiceRoleKey: "service-test" });
  process.env.LITELLM_ENDPOINT = "https://gateway.example.test";
  process.env.LITELLM_API_KEY = "gateway-test";
  process.env.PRODUCTION_VERIFY_TOKEN = "owner-test";
  process.env.RELEASE_REVISION = "a".repeat(40);
  process.env.RELEASE_BUILD_ID = `${process.env.RELEASE_REVISION}-123-1`;
  globalThis.fetch = async input => String(input).includes("/rpc/chat_schema_readiness")
    ? Response.json(installed) : new Response(null, { status: 200 });
  const server = createServer((req, res) => {
    void handleRuntimeRoute(req, res, new URL(req.url!, "http://localhost"), {}).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await nativeFetch(`http://127.0.0.1:${address.port}/api/ops/revision`, {
      headers: { authorization: "Bearer owner-test" },
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ready, false);
    assert.equal(body.buildRevision, null);
    assert.equal(body.buildId, null);
    assert.equal(body.databaseProjectRef, "stageproject");
    assert.deepEqual(body.checks, { database: true, gateway: true, chatbotSchema: true });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    globalThis.fetch = nativeFetch;
    Object.assign(config, savedConfig);
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test("release certification distinguishes rebuilds of the same revision using baked identity", async t => {
  const nativeFetch = globalThis.fetch;
  const savedConfig = { ...config };
  const keys = ["LITELLM_ENDPOINT", "LITELLM_API_KEY", "PRODUCTION_VERIFY_TOKEN", "RELEASE_REVISION", "RELEASE_BUILD_ID"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const revision = "b".repeat(40);
  const baked = { revision, buildId: `${revision}-123-1` };
  const releaseFile = new URL("../../apps/api/src/release.json", import.meta.url);
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (path: Parameters<typeof readFileSync>[0], options: Parameters<typeof readFileSync>[1]) =>
    path instanceof URL && path.href === releaseFile.href ? JSON.stringify(baked) : readFileSync(path, options));
  syncBuiltinESMExports();
  Object.assign(config, { supabaseUrl: "https://custom.example.test", supabaseServiceRoleKey: "service-test" });
  process.env.LITELLM_ENDPOINT = "https://gateway.example.test";
  process.env.LITELLM_API_KEY = "gateway-test";
  process.env.PRODUCTION_VERIFY_TOKEN = "owner-test";
  process.env.RELEASE_REVISION = revision;
  globalThis.fetch = async input => String(input).includes("/rpc/chat_schema_readiness")
    ? Response.json(installed) : new Response(null, { status: 200 });
  let server: Server | undefined;
  try {
    // Intentionally test module initialization with fresh mocked fs module cache
    const { handleRuntimeRoute: handleBakedRoute } = await import("../../apps/api/src/ops-runtime.js?baked-build-identity");
    server = createServer((req, res) => {
      void handleBakedRoute(req, res, new URL(req.url!, "http://localhost"), {}).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    for (const buildId of [baked.buildId, `${revision}-123-2`, undefined]) {
      if (buildId === undefined) delete process.env.RELEASE_BUILD_ID; else process.env.RELEASE_BUILD_ID = buildId;
      const response = await nativeFetch(`http://127.0.0.1:${address.port}/api/ops/revision`, {
        headers: { authorization: "Bearer owner-test" },
      });
      const matches = buildId === baked.buildId;
      assert.equal(response.status, matches ? 200 : 503);
      const body = await response.json();
      assert.equal(body.ready, matches);
      assert.equal(body.buildRevision, revision);
      assert.equal(body.buildId, baked.buildId, "configured expectations must not replace baked identity");
      assert.equal(body.databaseProjectRef, null, "custom hosts must not invent a hosted Supabase project");
      assert.deepEqual(body.checks, { database: true, gateway: true, chatbotSchema: true });
    }
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    }
    t.mock.restoreAll();
    syncBuiltinESMExports();
    globalThis.fetch = nativeFetch;
    Object.assign(config, savedConfig);
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
