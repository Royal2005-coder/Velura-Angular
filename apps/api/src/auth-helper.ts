import crypto from "node:crypto";
import { config } from "./config.js";

function jwtSecret(): string {
  const secret = process.env.JWT_SIGNING_SECRET || config.supabaseServiceRoleKey;
  if (secret) return secret;
  if (config.nodeEnv === "production") throw new Error("JWT signing secret is not configured");
  return "velura-development-only-secret";
}

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

/** Sign scoped credentials with an explicit lifetime and a configured production secret. */
export function signJwt(payload: Record<string, unknown>, expiresInSeconds = 24 * 60 * 60): string {
  const header = { alg: "HS256", typ: "JWT" };
  const sHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const sPayload = Buffer.from(JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds
  })).toString("base64url");
  const signature = crypto
    .createHmac("sha256", jwtSecret())
    .update(`${sHeader}.${sPayload}`)
    .digest("base64url");
  return `${sHeader}.${sPayload}.${signature}`;
}

/** Reject invalid algorithm, signature and expiration before trusting claims. */
export function verifyJwt(token: string): Record<string, unknown> | null {
  try {
    if (token.split(".").length !== 3) return null;
    const [sHeader, sPayload, signature] = token.split(".");
    const expectedSignature = crypto
      .createHmac("sha256", jwtSecret())
      .update(`${sHeader}.${sPayload}`)
      .digest("base64url");
    const header = JSON.parse(Buffer.from(sHeader, "base64url").toString("utf8")) as { alg?: unknown };
    if (header.alg !== "HS256") return null;
    const actual = Buffer.from(signature), expected = Buffer.from(expectedSignature);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(sPayload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof payload.exp !== "number" || Date.now() / 1000 >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
