import { config, getSupabaseServiceKey } from "./config.js";
import { HttpError } from "./http.js";
import { isJsonObject, type AuthUser, type JsonObject } from "./types.js";

/**
 * Options for a PostgREST / Auth HTTP call.
 */
export interface SupabaseRequestOptions {
  method?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  useAnonKey?: boolean;
  accessToken?: string | null;
  silentError?: boolean;
  /**
   * Chiến lược đếm tổng của PostgREST.
   *
   * `exact` bắt Postgres đếm toàn bảng sau khi lọc — đúng thứ trang danh sách cần để
   * phân trang, nhưng lãng phí với những truy vấn chỉ lấy một dòng hoặc chỉ tra nhãn.
   * Mặc định vẫn là `exact` để không đổi hành vi của các trang danh sách.
   */
  count?: "exact" | "planned" | "estimated" | "none";
}

/**
 * Successful PostgREST envelope.
 */
export interface SupabaseResponse {
  data: unknown;
  count: number | undefined;
  status: number;
}

let circuitState: "CLOSED" | "OPEN" = "CLOSED";
let failureCount = 0;
let fallbackUntil = 0;
const FALLBACK_COOLDOWN_MS = 60_000;
const CIRCUIT_OPEN_THRESHOLD = 3;
const PRIMARY_READ_RETRY_DELAYS_MS = [200, 500];

/** Reset the in-memory circuit breaker state. Intended for isolated unit tests. */
export function resetSupabaseCircuitForTest(): void {
  circuitState = "CLOSED";
  failureCount = 0;
  fallbackUntil = 0;
}

/** Extract low-level network error code/message (e.g. ECONNREFUSED, ENOTFOUND) for diagnostics. */
function describeNetworkError(error: unknown): { message: string; code?: string } {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeCode =
    cause && typeof cause === "object" && "code" in cause && typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : undefined;
  const causeMsg =
    cause instanceof Error && cause.message && cause.message !== error.message ? cause.message : undefined;
  return {
    message: causeMsg ? `${error.message} (${causeMsg})` : error.message,
    ...(causeCode ? { code: causeCode } : {})
  };
}

/** Close an open fallback circuit so the next request immediately probes Cloud Supabase primary. */
function closeFallbackCircuit(reason: string): void {
  if (circuitState === "OPEN" || fallbackUntil > 0 || failureCount > 0) {
    console.warn(`[CIRCUIT_BREAKER] Closing fallback circuit (${reason}) -> returning traffic to primary.`);
  }
  circuitState = "CLOSED";
  fallbackUntil = 0;
  failureCount = 0;
}

/** Resolve the active PostgREST/Auth base URL and its matching credential pair. */
export function getActiveSupabaseEndpoint(useAnonKey?: boolean, forcePrimary = false) {
  const isFallback = !forcePrimary && ((circuitState === "OPEN" && Date.now() < fallbackUntil) || !config.supabaseUrl);

  if (isFallback && config.supabaseFallbackUrl) {
    return {
      url: config.supabaseFallbackUrl,
      key: useAnonKey ? config.supabaseFallbackAnonKey : config.supabaseFallbackServiceRoleKey,
      isFallback: true,
    };
  }

  return {
    url: config.supabaseUrl,
    key: useAnonKey ? config.supabaseAnonKey : getSupabaseServiceKey(),
    isFallback: false,
  };
}

interface InternalSupabaseOptions extends SupabaseRequestOptions {
  /** Force a single attempt against the fallback stack without re-entering failover. */
  _target?: "primary" | "fallback";
}

/**
 * Call Supabase Auth or PostgREST.
 *
 * - Retries transient DNS/network/502+ blips on idempotent reads (GET/HEAD) before counting
 *   them as an outage (prevents single CoreDNS drops from tripping failover during Promise.all).
 * - Only latches the fallback circuit OPEN when the in-cluster standby actually responds healthy;
 *   never locks traffic onto an unreachable fallback for 60s.
 */
export async function supabaseRequest(
  path: string,
  options: SupabaseRequestOptions = {}
): Promise<SupabaseResponse> {
  return executeSupabaseRequest(path, options);
}

async function executeSupabaseRequest(
  path: string,
  options: InternalSupabaseOptions = {}
): Promise<SupabaseResponse> {
  const method = (options.method || "GET").toUpperCase();
  const isIdempotentRead = method === "GET" || method === "HEAD";
  const endpoint =
    options._target === "fallback" && config.supabaseFallbackUrl
      ? {
          url: config.supabaseFallbackUrl,
          key: options.useAnonKey ? config.supabaseFallbackAnonKey : config.supabaseFallbackServiceRoleKey,
          isFallback: true
        }
      : getActiveSupabaseEndpoint(options.useAnonKey, options._target === "primary");

  let resolvedPath = path;
  if (endpoint.url.includes("postgrest") && endpoint.url.includes(".svc") && resolvedPath.startsWith("/rest/v1")) {
    resolvedPath = resolvedPath.replace(/^\/rest\/v1/, "") || "/";
  }
  const url = new URL(resolvedPath, endpoint.url);

  Object.entries(options.query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    url.searchParams.set(key, String(value));
  });

  let key = endpoint.key;
  if (!key && options.useAnonKey !== false) {
    key = endpoint.isFallback ? config.supabaseFallbackAnonKey : config.supabaseAnonKey;
  }
  if (!key) {
    throw new HttpError(503, "SERVICE_ROLE_REQUIRED", "Supabase service role is not configured");
  }
  const headers: Record<string, string> = {
    apikey: key,
    accept: "application/json",
    ...options.headers
  };
  if (options.accessToken) {
    headers.authorization = `Bearer ${options.accessToken}`;
  } else if (key.startsWith("eyJ")) {
    headers.authorization = `Bearer ${key}`;
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const maxPrimaryAttempts = !endpoint.isFallback && isIdempotentRead ? PRIMARY_READ_RETRY_DELAYS_MS.length + 1 : 1;

  for (let attempt = 1; attempt <= maxPrimaryAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal
      });

      const text = await response.text();
      const data = text ? parseJson(text) : null;

      if (!response.ok) {
        const isTransientGateway = response.status >= 502 && response.status <= 504;
        if (!endpoint.isFallback && isTransientGateway && attempt < maxPrimaryAttempts) {
          await new Promise((resolve) => setTimeout(resolve, PRIMARY_READ_RETRY_DELAYS_MS[attempt - 1]));
          continue;
        }

        // If an active fallback returns 502+, do not keep trapping requests on a broken standby.
        if (endpoint.isFallback && response.status >= 502 && config.supabaseUrl && options._target !== "fallback") {
          closeFallbackCircuit(`fallback returned HTTP ${response.status}`);
          return executeSupabaseRequest(path, { ...options, _target: "primary" });
        }

        // 402 is a hard quota lockout, not a transient blip: try standby immediately.
        if ((response.status === 402 || response.status >= 502) && !endpoint.isFallback && config.supabaseFallbackUrl) {
          failureCount = response.status === 402 ? CIRCUIT_OPEN_THRESHOLD : failureCount + 1;
          if (failureCount >= CIRCUIT_OPEN_THRESHOLD) {
            return tryFallbackAndLatch(path, options, `Cloud Supabase returned ${response.status}`);
          }
        }
        if (!options.silentError) {
          console.error("[SUPABASE_ERROR_LOG]", response.status, url.toString(), "Response data:", data);
        }
        throw new HttpError(
          response.status,
          "SUPABASE_ERROR",
          `${supabaseErrorMessage(data)} [status:${response.status}]`,
          data
        );
      }

      // Request succeeded on primary
      if (!endpoint.isFallback) {
        failureCount = 0;
        circuitState = "CLOSED";
      }

      return {
        data,
        count: parseCount(response.headers.get("content-range")),
        status: response.status
      };
    } catch (error) {
      // An answered HTTP denial (4xx/RPC error) is not an outage: retrying it on the
      // fallback would replay a rejected RPC, and counting it would open the circuit.
      if (error instanceof HttpError) throw error;

      if (!endpoint.isFallback && attempt < maxPrimaryAttempts) {
        await new Promise((resolve) => setTimeout(resolve, PRIMARY_READ_RETRY_DELAYS_MS[attempt - 1]));
        continue;
      }

      // If an active fallback itself fails at network level, immediately close the circuit
      // and retry primary once instead of trapping every caller on a dead standby for 60s.
      if (endpoint.isFallback && config.supabaseUrl && options._target !== "fallback") {
        const net = describeNetworkError(error);
        closeFallbackCircuit(`fallback network error: ${net.code || net.message}`);
        return executeSupabaseRequest(path, { ...options, _target: "primary" });
      }

      if (!endpoint.isFallback && config.supabaseFallbackUrl) {
        failureCount++;
        if (failureCount >= CIRCUIT_OPEN_THRESHOLD) {
          const net = describeNetworkError(error);
          return tryFallbackAndLatch(
            path,
            options,
            `Network error connecting to Cloud Supabase (${net.code || net.message})`
          );
        }
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new HttpError(504, "SUPABASE_TIMEOUT", "Supabase request timed out");
      }
      throw new HttpError(502, "SUPABASE_NETWORK_ERROR", "Cannot reach Supabase", describeNetworkError(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new HttpError(502, "SUPABASE_NETWORK_ERROR", "Cannot reach Supabase");
}

/**
 * Probe the in-cluster standby once before latching the circuit OPEN.
 * If the standby is also unreachable (e.g. blocked by NetworkPolicy or restarting),
 * keep the circuit CLOSED so subsequent requests continue hitting Cloud Supabase.
 */
async function tryFallbackAndLatch(
  path: string,
  options: InternalSupabaseOptions,
  reason: string
): Promise<SupabaseResponse> {
  try {
    const fallbackResult = await executeSupabaseRequest(path, {
      ...options,
      silentError: true,
      _target: "fallback"
    });
    circuitState = "OPEN";
    fallbackUntil = Date.now() + FALLBACK_COOLDOWN_MS;
    console.warn(
      `[CIRCUIT_BREAKER] ${reason}. Standby responded OK -> latching circuit OPEN for ${FALLBACK_COOLDOWN_MS / 1000}s (${config.supabaseFallbackUrl})`
    );
    return fallbackResult;
  } catch (fallbackError) {
    // Only a 4xx business error proves standby is reachable; 502+ / network errors mean standby is dead.
    const isStandbyHealthyRejection =
      fallbackError instanceof HttpError && fallbackError.status >= 400 && fallbackError.status < 500;
    if (!isStandbyHealthyRejection) {
      closeFallbackCircuit(`${reason}; fallback ${config.supabaseFallbackUrl} also unreachable`);
    }
    throw fallbackError;
  }
}

/**
 * Resolve the Auth user for a bearer token, or null only when Supabase REJECTED the token (4xx).
 *
 * A network blip or 5xx is not a verdict on the token: it is retried (cluster DNS drops single
 * lookups) and, if it persists, thrown so callers report an outage instead of "token expired".
 * Swallowing it as null made a valid Google login fail intermittently with INVALID_TOKEN.
 */
export async function getAuthUser(accessToken: string): Promise<AuthUser | null> {
  if (!accessToken) return null;
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await supabaseRequest("/auth/v1/user", {
        useAnonKey: true,
        accessToken,
        silentError: true
      });
      return asAuthUser(result.data);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 0;
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) return null;
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
}

/**
 * Bọc một giá trị do người dùng gõ để PostgREST đọc nó như dữ liệu, không như cú pháp.
 *
 * Dấu phẩy, ngoặc đơn và nháy kép đều có nghĩa trong ngữ pháp lọc của PostgREST. Nối
 * thẳng chuỗi tìm kiếm vào `or=(...)` thì một câu bình thường như `Áo dài, đẹp` sẽ bị
 * tách ở dấu phẩy thành mệnh đề cụt và máy chủ trả 400 PGRST100. Đã kiểm chứng trực
 * tiếp trên PostgREST của dự án:
 *
 *   400 PGRST100  or=(name.ilike.*ao dai, dep*,sku.ilike.*ao dai, dep*)
 *   200 OK        or=(name.ilike."*ao dai, dep*",sku.ilike."*ao dai, dep*")
 *
 * Bọc trong nháy kép làm mọi ký tự bên trong thành dữ liệu; bên trong đó chỉ còn dấu
 * chéo ngược và nháy kép cần thoát, và phải thoát dấu chéo ngược TRƯỚC — làm ngược thứ
 * tự thì `\"` sinh ra ở bước sau lại bị bước trước nhân đôi và nháy kép thoát ra ngoài.
 * Dấu `*` vẫn giữ vai trò ký tự đại diện của `ilike` kể cả khi nằm trong nháy kép.
 *
 * Cách cũ là thay các ký tự đó bằng dấu cách, tức lặng lẽ tìm sai chuỗi khách gõ.
 */
export function quotePostgrestValue(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Select many rows from a PostgREST table.
 */
export async function selectRows(
  table: string,
  query: Record<string, unknown> = {},
  options: SupabaseRequestOptions = {}
): Promise<{ rows: JsonObject[]; count: number | undefined }> {
  const countStrategy = options.count ?? "exact";
  const result = await supabaseRequest(`/rest/v1/${table}`, {
    query,
    useAnonKey: options.useAnonKey,
    accessToken: options.accessToken,
    silentError: options.silentError,
    // Không gửi `prefer` thì PostgREST bỏ qua bước đếm hoàn toàn.
    headers: countStrategy === "none" ? {} : { prefer: `count=${countStrategy}` }
  });
  const rawRows = Array.isArray(result.data) ? result.data : [];
  return {
    rows: convertRawGithubUrls(rawRows),
    count: result.count
  };
}

/**
 * Select the first matching row, or null.
 */
export async function selectOne(
  table: string,
  query: Record<string, unknown> = {},
  options: SupabaseRequestOptions = {}
): Promise<JsonObject | null> {
  // Lấy đúng một dòng thì tổng số dòng của bảng không dùng vào việc gì; bỏ `count=exact`
  // ở đây cắt được một lần đếm toàn bảng cho mỗi lần tra cứu.
  const { rows } = await selectRows(table, { limit: 1, ...query }, { count: "none", ...options });
  return rows[0] || null;
}

/**
 * Call a PostgREST RPC.
 */
export async function callRpc(
  name: string,
  payload: unknown,
  options: SupabaseRequestOptions = {}
): Promise<unknown> {
  const result = await supabaseRequest(`/rest/v1/rpc/${name}`, {
    method: "POST",
    body: payload,
    useAnonKey: options.useAnonKey,
    accessToken: options.accessToken,
    silentError: options.silentError,
    headers: {
      prefer: "return=representation",
      ...(options.headers || {})
    }
  });
  const data = result.data;
  return Array.isArray(data)
    ? convertRawGithubUrls(data)
    : (data && typeof data === "object" ? convertRawGithubUrls([data])[0] : data);
}

/**
 * Insert one row and return the representation.
 */
export async function insertRow(
  table: string,
  payload: unknown,
  options: SupabaseRequestOptions = {}
): Promise<unknown> {
  const result = await supabaseRequest(`/rest/v1/${table}`, {
    method: "POST",
    body: payload,
    useAnonKey: options.useAnonKey,
    accessToken: options.accessToken,
    silentError: options.silentError,
    headers: {
      prefer: "return=representation"
    }
  });
  return Array.isArray(result.data) ? result.data[0] : result.data;
}

/**
 * Patch matching rows and return the representation list.
 */
export async function updateRows(
  table: string,
  query: Record<string, unknown>,
  payload: unknown,
  options: SupabaseRequestOptions = {}
): Promise<unknown[]> {
  const result = await supabaseRequest(`/rest/v1/${table}`, {
    method: "PATCH",
    query,
    body: payload,
    useAnonKey: options.useAnonKey,
    accessToken: options.accessToken,
    silentError: options.silentError,
    headers: {
      prefer: "return=representation"
    }
  });
  return Array.isArray(result.data) ? result.data : [];
}

/**
 * Delete matching rows.
 */
export async function deleteRows(
  table: string,
  query: Record<string, unknown>,
  options: SupabaseRequestOptions = {}
): Promise<void> {
  await supabaseRequest(`/rest/v1/${table}`, {
    method: "DELETE",
    query,
    useAnonKey: options.useAnonKey,
    accessToken: options.accessToken,
    headers: {
      prefer: "return=minimal"
    }
  });
}

function convertRawGithubUrls(rows: unknown[]): JsonObject[] {
  return rows.map((row) => {
    if (!isJsonObject(row)) return {};
    const next: JsonObject = { ...row };
    if (Array.isArray(next.images)) {
      next.images = next.images.map((img) => rewriteGithubCdn(img));
    }
    for (const key of ["image_url", "image", "product_image"]) {
      if (typeof next[key] === "string") {
        next[key] = rewriteGithubCdn(next[key]);
      }
    }
    return next;
  });
}

function rewriteGithubCdn(value: unknown): unknown {
  if (typeof value !== "string" || !value.includes("raw.githubusercontent.com")) return value;
  const regex = /https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(refs\/heads\/|)([^/]+)\/(.*)/;
  return value.replace(regex, "https://cdn.jsdelivr.net/gh/$1/$2@$4/$5");
}

function asAuthUser(value: unknown): AuthUser | null {
  if (!isJsonObject(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    email: typeof value.email === "string" ? value.email : null,
    phone: typeof value.phone === "string" ? value.phone : null
  };
}

function supabaseErrorMessage(data: unknown): string {
  if (isJsonObject(data)) {
    const msg = data.msg ?? data.message;
    if (typeof msg === "string") return msg;
  }
  return "Supabase request failed";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseCount(contentRange: string | null): number | undefined {
  if (!contentRange) return undefined;
  const total = contentRange.split("/")[1];
  return total && total !== "*" ? Number(total) : undefined;
}
