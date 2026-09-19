import crypto from "node:crypto";

const JWT_SECRET = process.env.VELURA_SUPABASE_SERVICE_ROLE_KEY || "velura-secret";

const SCRYPT_PREFIX = "scrypt";
const SCRYPT_KEYLEN = 64;

/**
 * Hashes a password with a per-password random salt using scrypt.
 * Format: `scrypt$<saltHex>$<derivedKeyHex>`.
 */
export function hashPassword(password: string): string {
  if (!password) return "";
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${SCRYPT_PREFIX}$${salt}$${derivedKey}`;
}

/**
 * Verifies a password against either the current salted scrypt format or the
 * legacy unsalted SHA-256 digest (kept only so existing accounts created
 * before this migration can still sign in; new/changed passwords always use
 * scrypt via `hashPassword`).
 */
export function verifyPassword(password: string, hash: string): boolean {
  if (!password || !hash) return false;
  if (hash.startsWith(`${SCRYPT_PREFIX}$`)) {
    const parts = hash.split("$");
    if (parts.length !== 3) return false;
    const [, salt, expectedHex] = parts;
    if (!salt || !expectedHex) return false;
    const expected = Buffer.from(expectedHex, "hex");
    const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  }
  return legacySha256(password) === hash;
}

function legacySha256(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

export function signJwt(payload: Record<string, unknown>): string {
  const header = { alg: "HS256", typ: "JWT" };
  const sHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const sPayload = Buffer.from(JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hours expiry
  })).toString("base64url");
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${sHeader}.${sPayload}`)
    .digest("base64url");
  return `${sHeader}.${sPayload}.${signature}`;
}

export function verifyJwt(token: string): Record<string, unknown> | null {
  try {
    const [sHeader, sPayload, signature] = token.split(".");
    const expectedSignature = crypto
      .createHmac("sha256", JWT_SECRET)
      .update(`${sHeader}.${sPayload}`)
      .digest("base64url");
    if (signature !== expectedSignature) return null;
    const payload = JSON.parse(Buffer.from(sPayload, "base64url").toString("utf8"));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
