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
}

/**
 * Successful PostgREST envelope.
 */
export interface SupabaseResponse {
  data: unknown;
  count: number | undefined;
  status: number;
}

/**
 * Call Supabase Auth or PostgREST. Maps network failures to HttpError.
 */
export async function supabaseRequest(
  path: string,
  options: SupabaseRequestOptions = {}
): Promise<SupabaseResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const url = new URL(path, config.supabaseUrl);

  Object.entries(options.query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    url.searchParams.set(key, String(value));
  });

  let key = options.useAnonKey ? config.supabaseAnonKey : getSupabaseServiceKey();
  if (!key && options.useAnonKey !== false) {
    key = config.supabaseAnonKey;
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

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body,
      signal: controller.signal
    });

    const text = await response.text();
    const data = text ? parseJson(text) : null;

    if (!response.ok) {
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

    return {
      data,
      count: parseCount(response.headers.get("content-range")),
      status: response.status
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(504, "SUPABASE_TIMEOUT", "Supabase request timed out");
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "SUPABASE_NETWORK_ERROR", "Cannot reach Supabase", {
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve the Auth user for a bearer token, or null if invalid.
 */
export async function getAuthUser(accessToken: string): Promise<AuthUser | null> {
  if (!accessToken) return null;
  try {
    const result = await supabaseRequest("/auth/v1/user", {
      useAnonKey: true,
      accessToken,
      silentError: true
    });
    return asAuthUser(result.data);
  } catch {
    return null;
  }
}

/**
 * Select many rows from a PostgREST table.
 */
export async function selectRows(
  table: string,
  query: Record<string, unknown> = {},
  options: SupabaseRequestOptions = {}
): Promise<{ rows: JsonObject[]; count: number | undefined }> {
  const result = await supabaseRequest(`/rest/v1/${table}`, {
    query,
    useAnonKey: options.useAnonKey,
    accessToken: options.accessToken,
    headers: {
      prefer: "count=exact"
    }
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
  const { rows } = await selectRows(table, { limit: 1, ...query }, options);
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
      prefer: "return=representation"
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
