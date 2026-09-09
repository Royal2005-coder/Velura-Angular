import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { ACCOUNT_SELECT } from "../../apps/api/src/accounts/account-constants.js";
import { applySecurityHeaders, readJson } from "../../apps/api/src/http.js";
import { createFixedWindowLimiter } from "../../apps/api/src/rate-limit.js";
import { readFile } from "node:fs/promises";

test("account projection excludes credentials and OTP fields", () => {
  assert.equal(ACCOUNT_SELECT.includes("password_hash"), false);
  assert.equal(ACCOUNT_SELECT.includes("otp_code"), false);
  assert.equal(ACCOUNT_SELECT.includes("shipping_addresses"), false);
});

test("readJson rejects bodies larger than the configured limit", async () => {
  const req = Readable.from([Buffer.alloc(11, "a")]);
  await assert.rejects(
    () => readJson(req, 10),
    (error) => error.status === 413 && error.code === "PAYLOAD_TOO_LARGE"
  );
});

test("API security headers block framing and MIME sniffing", () => {
  const headers = new Map();
  const res = { setHeader: (name, value) => headers.set(name, value) };
  applySecurityHeaders(res, "production");
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.match(headers.get("strict-transport-security"), /max-age=31536000/);
});

test("mutation limiter blocks requests beyond the fixed window", () => {
  const limiter = createFixedWindowLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.consume("actor", 100).allowed, true);
  assert.equal(limiter.consume("actor", 200).allowed, true);
  assert.equal(limiter.consume("actor", 300).allowed, false);
  assert.equal(limiter.consume("actor", 1200).allowed, true);
});

test("legacy generic admin mutation API is disabled", async () => {
  const server = await readFile(new URL("../../apps/api/src/server.js", import.meta.url), "utf8");
  assert.doesNotMatch(server, /insertRow|updateRows|deleteRows|handleAction|getResource/);
  assert.match(server, /LEGACY_ADMIN_API_DISABLED/);
});

test("A02 migration enforces RPC-only writes and public catalog boundaries", async () => {
  const migration = await readFile(new URL("../../database/migrations/002_uc_a02_products_inventory.sql", import.meta.url), "utf8");
  assert.match(migration, /revoke insert, update, delete, truncate on public\.product from anon, authenticated/);
  assert.match(migration, /create policy product_catalog_select/);
  assert.match(migration, /status::text = 'on_sale' or public\.velura_is_active_admin\(\)/);
  assert.match(migration, /velura_append_module_audit\([\s\S]*?'products'/);
  assert.match(migration, /INVALID_STATUS_TRANSITION/);
  assert.match(migration, /STOCK_UNDERFLOW/);
});

test("A03 migration enforces atomic order operations and RLS", async () => {
  const migration = await readFile(new URL("../../database/migrations/003_uc_a03_order_operations.sql", import.meta.url), "utf8");
  assert.match(migration, /create or replace function public\.admin_change_order_status/);
  assert.match(migration, /create or replace function public\.admin_cancel_order/);
  assert.match(migration, /create or replace function public\.admin_resolve_payment/);
  assert.match(migration, /for update/);
  assert.match(migration, /version = version \+ 1/);
  assert.match(migration, /reserved_quantity = greatest\(reserved_quantity - v_item\.quantity, 0\)/);
  assert.match(migration, /velura_append_module_audit\([\s\S]*?'orders'/);
  assert.match(migration, /revoke update, delete, truncate on public\.orders/);
  assert.match(migration, /create policy velura_orders_select_restriction on public\.orders as restrictive/);
  assert.doesNotMatch(migration, /insert into public\.order_status_history select/);
  assert.doesNotMatch(migration, /admin_operator_cskh_dt', 'admin_viewer/);
});

test("A01-A06 hardening migration restores RLS and removes anonymous RPC execution", async () => {
  const migration = await readFile(new URL("../../database/migrations/006_uc_a01_a06_rls_hardening.sql", import.meta.url), "utf8");
  for (const table of ["product", "variant", "review", "return_exchange", "return_item", "support_ticket", "promotion", "voucher", "promotion_product", "price_history"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /revoke execute on function %s from public, anon/);
  assert.match(migration, /review_owner_insert/);
  assert.match(migration, /return_owner_insert/);
  assert.match(migration, /promotion_public_select/);
  assert.match(migration, /revoke all on public\.review, public\.return_exchange/);
});

test("admin repositories propagate the caller JWT instead of bypassing RLS", async () => {
  const paths = [
    "../../apps/api/src/accounts/account-repository.js",
    "../../apps/api/src/reviews/review-repository.js",
    "../../apps/api/src/returns/return-repository.js",
    "../../apps/api/src/pricing/pricing-repository.js"
  ];
  for (const path of paths) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /useAnonKey:\s*true/);
    assert.match(source, /accessToken/);
    assert.doesNotMatch(source, /SELECT_OPTS\s*=\s*\{\s*useAnonKey:\s*false/);
  }
});
