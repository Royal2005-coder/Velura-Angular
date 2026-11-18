/**
 * SSRF-Safe Media Fetching, Private Return Evidence Ownership & Confined Static Asset Resolution.
 *
 * Enforces:
 * 1. `https:`-only outbound image fetches with strict host allowlisting and RFC1918/loopback/link-local/`.svc` blocking.
 * 2. Streaming byte-bounded body reads (`<= maxBytes`, default 10 MiB) with `redirect: "error"`.
 * 3. Cross-return IDOR protection requiring `storage://return-evidence-private/returns/${returnId}/...`.
 * 4. Path-traversal confinement for `/assets/...` local static files.
 */

import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { resolve, sep } from "node:path";
import { config } from "../config.js";
import { HttpError } from "../http.js";
import { PRIVATE_EVIDENCE_BUCKET, PUBLIC_EVIDENCE_BUCKET } from "../storage.js";

const DEFAULT_MAX_MEDIA_BYTES = 10 * 1024 * 1024;

function extractAllowedHosts(extraHosts: readonly string[] = []): Set<string> {
  const hosts = new Set<string>([
    "velura.royalai.dev",
    "admin.royalai.dev",
    "admin-erp.royalai.dev",
    "cdn.velura.vn",
    "velura.vn",
    "images.unsplash.com",
  ]);
  const candidateUrls = [
    process.env.VELURA_SUPABASE_URL,
    process.env.SUPABASE_URL,
    config.supabaseUrl,
    process.env.STOREFRONT_ORIGIN,
    config.storefrontOrigin,
  ];
  for (const raw of candidateUrls) {
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.hostname) hosts.add(parsed.hostname.toLowerCase());
    } catch {
      // Ignore unparseable config URL
    }
  }
  const csvHosts = (process.env.AI_CATALOG_IMAGE_HOSTS || "").split(",");
  for (const h of [...csvHosts, ...extraHosts]) {
    const clean = h.trim().toLowerCase();
    if (clean) hosts.add(clean);
  }
  return hosts;
}

/** Checks whether an IP literal or internal hostname belongs to loopback, link-local, RFC1918, or cluster-internal space. */
export function isBlockedInternalHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!lower) return true;
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower.endsWith(".svc") ||
    lower.includes(".svc.")
  ) {
    return true;
  }

  const ipVersion = isIP(lower);
  if (ipVersion === 4) {
    const parts = lower.split(".").map((n) => Number(n));
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (ipVersion === 6) {
    if (lower === "::1" || lower === "::" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) {
      return true;
    }
    if (lower.startsWith("::ffff:")) {
      return isBlockedInternalHost(lower.slice("::ffff:".length));
    }
    return true;
  }
  return false;
}

/** Validates that a media URL uses `https:` and targets an allowlisted, non-internal origin. */
export function assertSafeExternalMediaUrl(rawUrl: string, extraAllowedHosts: readonly string[] = []): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new HttpError(422, "INVALID_MEDIA_URL", "Đường dẫn ảnh không hợp lệ.");
  }
  if (parsed.protocol !== "https:") {
    throw new HttpError(422, "UNSAFE_MEDIA_SCHEME", "Chỉ cho phép tải ảnh qua giao thức an toàn https://.");
  }
  if (parsed.username || parsed.password) {
    throw new HttpError(422, "UNSAFE_MEDIA_URL", "Đường dẫn ảnh không được chứa thông tin xác thực.");
  }
  const host = parsed.hostname.toLowerCase();
  if (isBlockedInternalHost(host)) {
    throw new HttpError(422, "SSRF_HOST_BLOCKED", "Từ chối truy cập máy chủ nội bộ hoặc địa chỉ IP riêng tư.");
  }
  const allowlist = extractAllowedHosts(extraAllowedHosts);
  const hostAllowed =
    allowlist.has(host) ||
    host.endsWith(".supabase.co") ||
    host.endsWith(".supabase.in");
  if (!hostAllowed) {
    throw new HttpError(422, "MEDIA_HOST_NOT_ALLOWLISTED", `Tên miền ảnh '${host}' không nằm trong danh sách tin cậy.`);
  }
  return parsed;
}

/** Streams an external `https:` image up to `maxBytes` without buffering unbounded payloads in RAM. */
export async function fetchSafeMediaBytes(
  rawUrl: string,
  options: {
    maxBytes?: number;
    minBytes?: number;
    timeoutMs?: number;
    extraAllowedHosts?: readonly string[];
    fetchFn?: typeof fetch;
  } = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  const minBytes = options.minBytes ?? 16;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const safeUrl = assertSafeExternalMediaUrl(rawUrl, options.extraAllowedHosts);

  const resp = await fetchFn(safeUrl.toString(), {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => undefined);
    throw new HttpError(422, "IMAGE_FETCH_FAILED", "Không tải được tệp hình ảnh từ nguồn lưu trữ.");
  }

  const declaredLen = Number(resp.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    await resp.body?.cancel().catch(() => undefined);
    throw new HttpError(413, "IMAGE_TOO_LARGE", "Dung lượng ảnh vượt quá giới hạn 10 MB.");
  }

  if (!resp.body) {
    throw new HttpError(422, "INVALID_IMAGE", "Nguồn ảnh trả về dữ liệu rỗng.");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = resp.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new HttpError(413, "IMAGE_TOO_LARGE", "Dung lượng ảnh vượt quá giới hạn 10 MB.");
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = Buffer.concat(chunks, total);
  if (buffer.length < minBytes) {
    throw new HttpError(422, "INVALID_IMAGE", "Tệp hình ảnh quá nhỏ hoặc bị hỏng.");
  }
  return buffer;
}

/** Verifies that a private return evidence storage URI strictly belongs to the specified `returnId`. */
export function assertReturnEvidenceOwnership(
  storageRef: string,
  returnId: string,
  allowedBuckets: readonly string[] = [PRIVATE_EVIDENCE_BUCKET, PUBLIC_EVIDENCE_BUCKET],
): { bucket: string; objectPath: string } {
  const trimmed = storageRef.trim();
  const safeReturnId = returnId.trim();
  if (!safeReturnId || safeReturnId.includes("/") || safeReturnId.includes("..")) {
    throw new HttpError(422, "INVALID_RETURN_ID", "Mã hồ sơ đổi trả không hợp lệ.");
  }
  if (!trimmed.startsWith("storage://")) {
    throw new HttpError(
      422,
      "EVIDENCE_OWNERSHIP_VIOLATION",
      "Bằng chứng kiểm hàng phải dùng tham chiếu kho lưu trữ nội bộ storage:// hợp lệ.",
    );
  }
  const rest = trimmed.slice("storage://".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx <= 0) {
    throw new HttpError(422, "EVIDENCE_OWNERSHIP_VIOLATION", "Đường dẫn bằng chứng đổi trả không đúng định dạng.");
  }
  const bucket = rest.slice(0, slashIdx);
  const objectPath = rest.slice(slashIdx + 1);
  if (
    !allowedBuckets.includes(bucket) ||
    objectPath.includes("..") ||
    objectPath.includes("\\") ||
    !objectPath.startsWith(`returns/${safeReturnId}/`)
  ) {
    throw new HttpError(
      422,
      "EVIDENCE_OWNERSHIP_VIOLATION",
      "Bằng chứng hình ảnh không thuộc hồ sơ đổi trả hiện tại.",
    );
  }
  return { bucket, objectPath };
}

/** Resolves a `/assets/...` static path strictly within approved frontend public asset roots. */
export function resolveSafePublicAssetPath(relUrl: string, workspaceRoot = process.cwd()): string | null {
  const trimmed = relUrl.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("\0") || trimmed.includes("\\")) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return null;
  }
  const stripped = decoded.replace(/^\/+/, "");
  if (!stripped.startsWith("assets/") || stripped.split("/").some((seg) => seg === ".." || seg === ".")) {
    throw new HttpError(422, "ASSET_PATH_FORBIDDEN", "Đường dẫn tài nguyên nội bộ không được phép truy cập.");
  }

  const allowedRoots = [
    resolve(workspaceRoot, "apps/user-ng/public/assets"),
    resolve(workspaceRoot, "apps/admin-erp-ng/public/assets"),
    resolve(workspaceRoot, "apps/admin-ng/public/assets"),
    resolve(workspaceRoot, "../../apps/user-ng/public/assets"),
  ];

  const subPath = stripped.slice("assets/".length);
  for (const root of allowedRoots) {
    const candidate = resolve(root, subPath);
    if ((candidate === root || candidate.startsWith(root + sep)) && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
