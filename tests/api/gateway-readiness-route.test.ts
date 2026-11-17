import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { HttpError, sendError } from "../../apps/api/src/http.js";
import { handleGatewayReadinessRoute } from "../../apps/api/src/payments/gateway-readiness.js";
import { assertLocalGatewayReady } from "../../apps/api/src/payments/local-gateways.js";
import type { AuthContext, HttpRequest, HttpResponse } from "../../apps/api/src/types.js";

const PARTS = ["api", "v1", "admin", "payments", "gateway-readiness"];

function context(roleCode: string, isAdmin: boolean): AuthContext {
  return {
    authUser: { id: "user-1" },
    profile: { user_id: "user-1" },
    roleCode, roleName: roleCode, isAdmin, allowedPages: [], allowedModules: []
  } as unknown as AuthContext;
}

interface Captured { status: number; headers: Record<string, string>; body: string }

function response(): { res: HttpResponse; out: Captured } {
  const out: Captured = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) { out.status = status; Object.assign(out.headers, headers); return this; },
    end(data?: string) { if (data) out.body += data; return this; },
    setHeader(name: string, value: string) { out.headers[name] = value; return this; }
  };
  return { res: res as unknown as HttpResponse, out };
}

async function call(ctx: AuthContext | undefined): Promise<Captured> {
  const { res, out } = response();
  const req = { method: "GET", url: "/" + PARTS.join("/"), headers: { "x-forwarded-for": "10.0.0.9" }, socket: {} } as unknown as HttpRequest;
  try {
    assert.equal(await handleGatewayReadinessRoute({ req, res, url: new URL("http://localhost/" + PARTS.join("/")), parts: PARTS, context: ctx, headers: {}, service: undefined }), true);
  } catch (error) {
    sendError(res, error);
  }
  return out;
}

async function withAuditSink<T>(run: (rows: Record<string, unknown>[]) => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const before = { url: config.supabaseUrl, key: config.supabaseServiceRoleKey };
  const rows: Record<string, unknown>[] = [];
  config.supabaseUrl = "https://postgrest.test";
  config.supabaseServiceRoleKey = "service-key-for-tests";
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/rest/v1/audit_log" && init?.body) rows.push(JSON.parse(String(init.body)));
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return await run(rows);
  } finally {
    globalThis.fetch = originalFetch;
    config.supabaseUrl = before.url;
    config.supabaseServiceRoleKey = before.key;
  }
}

test("gateway readiness: guest and non-super roles get 403 with no report", async () => {
  for (const ctx of [undefined, context("guest", false), context("customer", false), context("admin_viewer", true), context("super_admin", false)]) {
    const out = await call(ctx);
    assert.equal(out.status, 403, `role ${ctx?.roleCode ?? "none"} must be rejected`);
    assert.equal(out.body.includes("node_env"), false);
  }
});

test("gateway readiness: super_admin gets a no-store, secret-free report and an audit row", async () => {
  const before = { vnpayHashSecret: config.vnpayHashSecret, vnpayTmnCode: config.vnpayTmnCode };
  config.vnpayHashSecret = "hash-secret-value";
  config.vnpayTmnCode = "merchant-secret-value";
  try {
    await withAuditSink(async (rows) => {
      const out = await call(context("super_admin", true));
      assert.equal(out.status, 200);
      assert.equal(out.headers["cache-control"], "no-store");
      assert.equal(out.body.includes("secret-value"), false);
      assert.ok("providers" in JSON.parse(out.body));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, "view_gateway_readiness");
      assert.equal(rows[0].actor_role, "super_admin");
      assert.equal(rows[0].ip_address, "10.0.0.9");
    });
  } finally {
    Object.assign(config, before);
  }
});

test("gateway readiness: an audit write failure does not hide the report", async () => {
  const originalFetch = globalThis.fetch;
  const before = { url: config.supabaseUrl, key: config.supabaseServiceRoleKey };
  config.supabaseUrl = "https://postgrest.test";
  config.supabaseServiceRoleKey = "service-key-for-tests";
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  const errors = console.error;
  console.error = () => undefined;
  try {
    assert.equal((await call(context("super_admin", true))).status, 200);
  } finally {
    console.error = errors;
    globalThis.fetch = originalFetch;
    config.supabaseUrl = before.url;
    config.supabaseServiceRoleKey = before.key;
  }
});

test("storefront errors never carry provider diagnostics", () => {
  const before = { nodeEnv: config.nodeEnv, origin: config.apiPublicOrigin, env: config.paymentGatewayEnvironment, simulator: config.paymentGatewaySimulator, tmn: config.vnpayTmnCode, hash: config.vnpayHashSecret };
  const warn = console.warn;
  const logged: unknown[][] = [];
  console.warn = (...args: unknown[]) => { logged.push(args); };
  try {
    config.nodeEnv = "production"; config.apiPublicOrigin = "https://api.velura.test";
    config.paymentGatewayEnvironment = "sandbox"; config.paymentGatewaySimulator = false;
    config.vnpayTmnCode = ""; config.vnpayHashSecret = "";
    let thrown: unknown;
    try { assertLocalGatewayReady("VNPAY"); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof HttpError);
    assert.equal(thrown.code, "GATEWAY_NOT_CONFIGURED");
    const { res, out } = response();
    sendError(res, thrown);
    assert.equal(out.status, 503);
    for (const leaked of ["CREDENTIALS_MISSING", "VNPAY", "reason", "provider"]) assert.equal(out.body.includes(leaked), false, leaked);
    assert.ok(logged.some((entry) => JSON.stringify(entry).includes("CREDENTIALS_MISSING")), "reason is logged server-side");

    const legacy = response();
    sendError(legacy.res, new HttpError(502, "GATEWAY_OPEN_FAILED", "Không kết nối được MoMo.", { reason: "TIMEOUT", provider: "MOMO", http_status: 502, result_code: 9, provider_message: "x" }));
    for (const leaked of ["TIMEOUT", "MOMO", "provider_message", "result_code", "http_status"]) assert.equal(legacy.out.body.includes(leaked), false, leaked);
  } finally {
    console.warn = warn;
    Object.assign(config, { nodeEnv: before.nodeEnv, apiPublicOrigin: before.origin, paymentGatewayEnvironment: before.env, paymentGatewaySimulator: before.simulator, vnpayTmnCode: before.tmn, vnpayHashSecret: before.hash });
  }
});
