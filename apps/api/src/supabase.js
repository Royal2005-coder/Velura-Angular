import { config, getSupabaseServiceKey } from "./config.js";
import { HttpError } from "./http.js";

export async function supabaseRequest(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const url = new URL(path, config.supabaseUrl);

  Object.entries(options.query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    url.searchParams.set(key, String(value));
  });

  let key = options.useAnonKey ? config.supabaseAnonKey : getSupabaseServiceKey();
  if (!key && options.useAnonKey !== false) {
    // Fallback to anon key if service role is not configured but not strictly disabled
    key = config.supabaseAnonKey;
  }
  if (!key) {
    throw new HttpError(503, "SERVICE_ROLE_REQUIRED", "Supabase service role is not configured");
  }
  const headers = {
    apikey: key,
    accept: "application/json",
    ...options.headers
  };
  if (options.accessToken) {
    headers.authorization = `Bearer ${options.accessToken}`;
  } else if (key.startsWith("eyJ")) {
    headers.authorization = `Bearer ${key}`;
  }

  let body;
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
      throw new HttpError(response.status, "SUPABASE_ERROR", (data?.msg || data?.message || "Supabase request failed") + " [status:" + response.status + "]", data);
    }

    return {
      data,
      count: parseCount(response.headers.get("content-range")),
      status: response.status
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new HttpError(504, "SUPABASE_TIMEOUT", "Supabase request timed out");
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "SUPABASE_NETWORK_ERROR", "Cannot reach Supabase", {
      message: error.message
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function getAuthUser(accessToken) {
  if (!accessToken) return null;
  try {
    const result = await supabaseRequest("/auth/v1/user", {
      useAnonKey: true,
      accessToken,
      silentError: true
    });
    return result.data;
  } catch {
    return null;
  }
}

function convertRawGithubUrls(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(r => {
    if (r && typeof r === "object") {
      if (r.images && Array.isArray(r.images)) {
        r.images = r.images.map(img => {
          if (typeof img === "string" && img.includes("raw.githubusercontent.com")) {
            const regex = /https:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/(refs\/heads\/|)([^\/]+)\/(.*)/;
            return img.replace(regex, "https://cdn.jsdelivr.net/gh/$1/$2@$4/$5");
          }
          return img;
        });
      }
      for (const key of ["image_url", "image", "product_image"]) {
        if (typeof r[key] === "string" && r[key].includes("raw.githubusercontent.com")) {
          const regex = /https:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/(refs\/heads\/|)([^\/]+)\/(.*)/;
          r[key] = r[key].replace(regex, "https://cdn.jsdelivr.net/gh/$1/$2@$4/$5");
        }
      }
    }
    return r;
  });
}

export async function selectRows(table, query = {}, options = {}) {
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

export async function selectOne(table, query = {}, options = {}) {
  const { rows } = await selectRows(table, { limit: 1, ...query }, options);
  return rows[0] || null;
}

export async function callRpc(name, payload, options = {}) {
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

export async function insertRow(table, payload, options = {}) {
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

export async function updateRows(table, query, payload, options = {}) {
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

export async function deleteRows(table, query, options = {}) {
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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseCount(contentRange) {
  if (!contentRange) return undefined;
  const total = contentRange.split("/")[1];
  return total && total !== "*" ? Number(total) : undefined;
}
