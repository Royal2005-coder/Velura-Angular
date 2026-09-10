import crypto from "node:crypto";

const JWT_SECRET = process.env.VELURA_SUPABASE_SERVICE_ROLE_KEY || "velura-secret";

export function hashPassword(password: string): string {
  if (!password) return "";
  return crypto.createHash("sha256").update(password).digest("hex");
}

export function verifyPassword(password: string, hash: string): boolean {
  if (!password || !hash) return false;
  return hashPassword(password) === hash;
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
