import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleAccountRoute } from "../../apps/api/src/accounts/account-router.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const REASON = "Tai khoan co dau hieu vi pham nghiem trong dieu khoan bao mat cua he thong";

test("GET account list returns the service payload", async () => {
  const req = request("GET");
  const res = response();
  const handled = await handleAccountRoute({
    req, res,
    url: new URL("http://localhost/api/v1/admin/accounts?limit=10"),
    parts: ["api", "v1", "admin", "accounts"],
    context: superAdminContext(), headers: {},
    service: { list: async (_context, params) => ({ rows: [{ user_id: USER_ID }], count: Number(params.get("limit")) }) }
  });

  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { rows: [{ user_id: USER_ID }], count: 10 });
});

test("POST account lock passes parsed input and request IP", async () => {
  const req = request("POST", JSON.stringify({ lockType: "temporary", reason: REASON, expectedVersion: 2 }));
  let received;
  const res = response();

  await handleAccountRoute({
    req, res,
    url: new URL(`http://localhost/api/v1/admin/accounts/${USER_ID}/lock`),
    parts: ["api", "v1", "admin", "accounts", USER_ID, "lock"],
    context: superAdminContext(), headers: {},
    service: {
      lock: async (...args) => {
        received = args;
        return { user_id: USER_ID, is_active: false, version: 3 };
      }
    }
  });

  assert.equal(res.status, 200);
  assert.equal(received[1], USER_ID);
  assert.equal(received[2].expectedVersion, 2);
  assert.equal(received[3].ipAddress, "127.0.0.1");
});

test("role escalation returns 202 while approval is pending", async () => {
  const req = request("POST", JSON.stringify({ role: "admin", adminRole: "super_admin", expectedVersion: 3 }));
  const res = response();
  await handleAccountRoute({
    req, res,
    url: new URL(`http://localhost/api/v1/admin/accounts/${USER_ID}/role`),
    parts: ["api", "v1", "admin", "accounts", USER_ID, "role"],
    context: superAdminContext(), headers: {},
    service: { changeRole: async () => ({ kind: "approval", request: { status: "pending" } }) }
  });
  assert.equal(res.status, 202);
  assert.equal(res.json().request.status, "pending");
});

function request(method, body = "") {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.headers = {};
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}

function response() {
  return {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; },
    end(body = "") { this.body = body; },
    json() { return JSON.parse(this.body); }
  };
}

function superAdminContext() {
  return {
    authUser: { id: "auth-1" },
    profile: { user_id: "actor-1", is_active: true },
    isAdmin: true,
    roleCode: "super_admin",
    accessToken: "token"
  };
}
