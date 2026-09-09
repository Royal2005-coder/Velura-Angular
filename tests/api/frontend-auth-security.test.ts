import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

async function source(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

test("admin browser code delegates identity and RBAC to the backend", async () => {
  const [login, callback, session, api] = await Promise.all([
    source("apps/admin-ng/src/app/features/login/admin-login.page.ts"),
    source("apps/admin-ng/src/app/features/login/admin-auth-callback.page.ts"),
    source("apps/admin-ng/src/app/core/admin-session.service.ts"),
    source("apps/admin-ng/src/app/core/admin-api.service.ts")
  ]);
  const browserCode = `${login}\n${callback}\n${session}\n${api}`;
  assert.doesNotMatch(browserCode, /from\(["']users["']\)/i);
  assert.doesNotMatch(browserCode, /\/rest\/v1\/users/i);
  assert.doesNotMatch(browserCode, /password_hash|otp_code/i);
  assert.doesNotMatch(browserCode, /Velura@123|reset123/i);
  assert.match(api, /\/api\/auth\/me/);
  assert.match(callback, /this\.api\.me\(\)/);
});

test("Supabase OAuth uses API PKCE, not a hardcoded Supabase host", async () => {
  const [login, callback, api] = await Promise.all([
    source("apps/admin-ng/src/app/features/login/admin-login.page.ts"),
    source("apps/admin-ng/src/app/features/login/admin-auth-callback.page.ts"),
    source("apps/admin-ng/src/app/core/admin-api.service.ts")
  ]);
  assert.match(login, /velura-oauth-pkce-code-verifier/);
  assert.match(login, /\/api\/auth\/google/);
  assert.match(login, /code_challenge/);
  assert.match(login, /localStorage\.setItem\(PKCE_STORAGE_KEY/);
  assert.doesNotMatch(login, /drvkrpoojyncodfytftn/);
  assert.match(callback, /velura-oauth-pkce-code-verifier/);
  assert.match(callback, /window\.location\.origin\}\/auth\/callback/);
  assert.match(api, /\/api\/auth\/pkce/);
});

test("password changes require twelve characters and no demo password", async () => {
  const page = await source("apps/admin-ng/src/app/features/login/admin-change-password.page.ts");
  assert.match(page, /Validators\.minLength\(12\)/);
  assert.doesNotMatch(page, /Velura@123|mustChangePassword/);
});

test("active seed directory contains no privilege hotfix SQL", async () => {
  const seedDirectory = path.join(ROOT, "database", "seed");
  const entries = await readdir(seedDirectory);
  assert.deepEqual(entries.filter((name) => name.endsWith(".sql")), []);
  const readme = await source("database/seed/README.md");
  assert.match(readme, /seed-admin-users\.mjs/);
});

test("admin mutations send expectedVersion through typed API services", async () => {
  const [accounts, products, orders, api] = await Promise.all([
    source("apps/admin-ng/src/app/features/accounts/admin-accounts.page.ts"),
    source("apps/admin-ng/src/app/features/catalog/admin-products.page.ts"),
    source("apps/admin-ng/src/app/features/orders/admin-orders.page.ts"),
    source("apps/admin-ng/src/app/core/admin-api.service.ts")
  ]);
  assert.match(accounts, /expectedVersion:\s*row\.version/);
  assert.match(products, /expectedVersion:\s*product\.version/);
  assert.match(orders, /expectedVersion:\s*order\.version/);
  assert.match(api, /\/api\/v1\/admin\/products/);
  assert.match(api, /\/api\/v1\/admin\/orders/);
  assert.doesNotMatch(`${accounts}\n${products}\n${orders}\n${api}`, /\/rest\/v1\//);
});

test("dashboard backend uses the canonical, service-only Supabase aggregation", async () => {
  const [dashboard, migration] = await Promise.all([
    source("apps/api/src/dashboard.ts"),
    source("database/migrations/018_admin_dashboard_summary.sql")
  ]);
  assert.match(dashboard, /callRpc\("get_admin_dashboard_summary"/);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /revoke all on function .* from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function .* to service_role/i);
  assert.match(migration, /join current_orders o on o\.order_id = oi\.order_id/i);
  assert.match(migration, /count\(distinct product_id\)/i);
});

test("admin registration page has no demo account creation path", async () => {
  const register = await source("apps/admin-ng/src/app/features/login/admin-register.page.ts");
  assert.doesNotMatch(register, /auth-core|Velura@123|Google OAuth Demo|loginWithGoogle/);
  assert.match(register, /Đăng ký admin đã tắt trong production/);
});

test("source tree contains no hard-coded Supabase management or secret key", async () => {
  const candidates = [".env.example", "apps/api/src/server.ts", "apps/api/src/supabase.ts"];
  const combined = (await Promise.all(candidates.map(source))).join("\n");
  assert.doesNotMatch(combined, /sbp_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(combined, /postgresql:\/\/[^\s]+:[^\s\[]+@/);
});

test("customer auth uses live API contracts and no demo login", async () => {
  const [signin, signup, forgot, otp] = await Promise.all([
    source("apps/user-ng/src/app/features/auth/sign-in.page.ts"),
    source("apps/user-ng/src/app/features/auth/sign-up.page.ts"),
    source("apps/user-ng/src/app/features/auth/forgot-password.page.ts"),
    source("apps/user-ng/src/app/shared/auth-otp-modal/auth-otp-modal.ts")
  ]);
  assert.match(signin, /\/api\/user\/auth\/signin/);
  assert.match(signup, /\/api\/user\/auth\/signup/);
  assert.match(forgot, /\/api\/user\/auth\/otp-send/);
  assert.match(otp, /\/api\/user\/auth\/otp-verify/);
  assert.doesNotMatch(`${signin}\n${signup}`, /js-dev-login|Test Phone|Test Email|createDevMemberSession/);
});

test("customer member flows require a real auth session", async () => {
  const [rbac, interceptor, wishlist] = await Promise.all([
    source("apps/api/src/rbac.ts"),
    source("apps/user-ng/src/app/core/interceptors/auth.interceptor.ts"),
    source("apps/user-ng/src/app/core/services/wishlist.store.ts")
  ]);
  assert.match(rbac, /import \{ verifyJwt \} from "\.\/auth-helper\.js"/);
  assert.match(rbac, /const decoded = verifyJwt\(token\)/);
  assert.match(interceptor, /Authorization/);
  assert.match(wishlist, /\/api\/user\/wishlist/);
  assert.doesNotMatch(`${interceptor}\n${wishlist}`, /createDevMemberSession|member\.test@velura\.local/);
});

test("customer wishlist uses users.wishlist JSON and not a dedicated wishlist table", async () => {
  const [wishlistRoute, legacyWishlistRoute, schema] = await Promise.all([
    source("apps/api/src/user/wishlist.ts"),
    source("apps/api/src/v1-wishlist-routes.ts"),
    source("database/database_user/schema.sql")
  ]);
  const combinedRoutes = `${wishlistRoute}\n${legacyWishlistRoute}`;
  assert.match(wishlistRoute, /selectOne\("users"/);
  assert.match(wishlistRoute, /updateRows\("users"/);
  assert.match(wishlistRoute, /wishlist:\s*normalizeWishlist/);
  assert.doesNotMatch(combinedRoutes, /["']Wishlists["']/);
  assert.doesNotMatch(combinedRoutes, /insertRow\(|deleteRows\(/);
  assert.match(schema, /wishlist\s+JSONB\s+NOT NULL DEFAULT '\[\]'/i);
  assert.doesNotMatch(schema, /CREATE TABLE\s+Wishlists/i);
});

test("profile birthday validation stays on the API contract", async () => {
  const [profileApi, rbac] = await Promise.all([
    source("apps/api/src/user/profile.ts"),
    source("apps/api/src/rbac.ts")
  ]);
  assert.match(profileApi, /validateDateOfBirth\(date_of_birth\)/);
  assert.match(profileApi, /user_id:\s*`eq\.\$\{profile\.user_id\}`/);
  assert.match(rbac, /"date_of_birth",\s*"gender"/);
});
