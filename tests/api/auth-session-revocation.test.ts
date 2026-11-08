import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

test("UAT #742: sign-out bumps the server-side token epoch so old JWTs stop working", async () => {
  const [migration, rbac, auth, profileSelect, types] = await Promise.all([
    source("database/migrations/118_auth_session_revocation_and_otp_attempts.sql"),
    source("apps/api/src/rbac.ts"),
    source("apps/api/src/user/auth.ts"),
    source("apps/api/src/auth-profile.ts"),
    source("apps/api/src/types.ts")
  ]);
  assert.match(migration, /add column if not exists token_epoch integer not null default 0/);
  assert.match(profileSelect, /"token_epoch"/);
  assert.match(types, /token_epoch\?: number \| null/);
  // Token phát ra mang epoch hiện tại; buildAuthContext từ chối token có epoch cũ.
  assert.match(auth, /tv: Number\(user\.token_epoch \?\? 0\)/);
  assert.match(rbac, /Number\(decoded\.tv \?\? 0\) !== Number\(profile\.token_epoch \?\? 0\)/);
  assert.match(rbac, /buildGuestContext\(ipAddress\)/);
  // Logout tăng epoch thay vì chỉ xoá localStorage.
  assert.match(auth, /action === "logout"/);
  assert.match(auth, /token_epoch: Number\(profile\.token_epoch \?\? 0\) \+ 1/);
});

test("UAT #742: the browser calls the revoking endpoint before clearing the session", async () => {
  const [api, header, interceptor] = await Promise.all([
    source("apps/user-ng/src/app/core/services/api.service.ts"),
    source("apps/user-ng/src/app/layout/site-header/site-header.ts"),
    source("apps/user-ng/src/app/core/interceptors/auth.interceptor.ts")
  ]);
  assert.match(api, /\/api\/user\/auth\/logout/);
  assert.match(header, /this\.api\.logout\(\)/);
  // Đăng xuất cục bộ vẫn xảy ra khi API lỗi, nhưng chỉ sau khi đã cố thu hồi token.
  assert.match(header, /error: \(\) => this\.finishLogout\(\)/);
  // Interceptor phải gắn Bearer cho logout, nếu không server không biết thu hồi phiên nào.
  assert.match(interceptor, /!req\.url\.includes\('\/api\/user\/auth\/logout'\)/);
});

test("UAT #747: every OTP consumer counts wrong attempts and resets on a new code", async () => {
  const [migration, auth] = await Promise.all([
    source("database/migrations/118_auth_session_revocation_and_otp_attempts.sql"),
    source("apps/api/src/user/auth.ts")
  ]);
  assert.match(migration, /add column if not exists otp_attempt_count integer not null default 0/);
  // Cả otp-verify lẫn reset-password dùng chung kiểm tra có đếm lần sai.
  assert.equal(auth.match(/await assertOtpAccepted\(user, otp_code,/g)?.length, 2);
  assert.match(auth, /nextOtpAttemptFailure\(user\.otp_attempt_count\)/);
  assert.match(auth, /"OTP_ATTEMPTS_EXCEEDED"/);
  // Mã mới hoặc xác thực thành công phải trả bộ đếm về 0.
  assert.ok((auth.match(/otp_attempt_count: 0/g)?.length ?? 0) >= 4);
});
