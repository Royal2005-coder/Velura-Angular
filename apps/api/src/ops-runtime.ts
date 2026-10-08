import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import { HttpError, sendJson } from "./http.js";
import { readAiGatewayMetrics } from "./gemini-client.js";
import type { HeaderMap } from "./types.js";

const bounds = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 60];
interface Measurement { count: number; seconds: number; buckets: number[]; }
const http = new Map<string, Measurement>();

/** Observe bounded route families and status classes, never request bodies, query strings or identities. */
export function observeHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  const started = performance.now();
  const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(req.method || "") ? req.method! : "OTHER";
  let pathname = "/invalid";
  try { pathname = new URL(req.url || "/", "http://localhost").pathname; } catch { /* Invalid URLs use one bounded label. */ }
  const family = pathname === "/health" || pathname === "/ready" || pathname === "/metrics" ? pathname
    : pathname.startsWith("/api/v1/admin/") ? "/api/v1/admin"
    : pathname.startsWith("/api/user/") ? "/api/user"
    : pathname.startsWith("/api/") ? "/api" : "/other";
  res.once("finish", () => {
    const key = `${method}|${family}|${Math.floor(res.statusCode / 100)}xx`;
    let value = http.get(key);
    if (!value) { value = { count: 0, seconds: 0, buckets: bounds.map(() => 0) }; http.set(key, value); }
    const seconds = (performance.now() - started) / 1000;
    value.count++; value.seconds += seconds;
    for (let i = 0; i < bounds.length; i++) if (seconds <= bounds[i]!) value.buckets[i]!++;
  });
}

/** Render content-free Prometheus counters and histograms; the ingress must keep this endpoint private. */
export function runtimeMetrics(): string {
  const lines = ["# TYPE velura_http_requests_total counter", "# TYPE velura_http_request_duration_seconds histogram"];
  for (const [key, value] of http) {
    const [method, route, status] = key.split("|");
    const labels = `method="${method}",route="${route}",status="${status}"`;
    lines.push(`velura_http_requests_total{${labels}} ${value.count}`);
    for (let i = 0; i < bounds.length; i++) lines.push(`velura_http_request_duration_seconds_bucket{${labels},le="${bounds[i]}"} ${value.buckets[i]}`);
    lines.push(`velura_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${value.count}`, `velura_http_request_duration_seconds_count{${labels}} ${value.count}`, `velura_http_request_duration_seconds_sum{${labels}} ${value.seconds}`);
  }
  for (const value of readAiGatewayMetrics()) {
    const labels = `operation="${value.operation}"`;
    for (const [name, count] of [["requests", value.requests], ["failures", value.failures], ["retries", value.retries], ["input_tokens", value.promptTokens], ["output_tokens", value.completionTokens], ["usage_measurements", value.usageMeasurements], ["cost_measurements", value.costMeasurements]] as const) lines.push(`velura_ai_${name}_total{${labels}} ${count}`);
    lines.push(`velura_ai_duration_seconds_sum{${labels}} ${value.latencyMs / 1000}`);
    if (value.costMeasurements) lines.push(`velura_ai_cost_usd_total{${labels}} ${value.costUsd}`);
  }
  return lines.join("\n") + "\n";
}

/** Verify reachable data and gateway services without inference, sensitive rows or provider credential disclosure. */
export async function runtimeReadiness(): Promise<{ ready: boolean; checks: { database: boolean; gateway: boolean } }> {
  async function check(url: string, headers: Record<string, string>): Promise<boolean> {
    try { const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(3000) }); await response.body?.cancel(); return response.ok; } catch { return false; }
  }
  const databaseKey = config.supabaseServiceRoleKey || config.supabaseAnonKey;
  const endpoint = process.env.LITELLM_ENDPOINT?.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const [database, gateway] = await Promise.all([
    config.supabaseUrl && databaseKey ? check(`${config.supabaseUrl}/rest/v1/product?select=product_id&limit=0`, { apikey: databaseKey, authorization: `Bearer ${databaseKey}` }) : false,
    endpoint && process.env.LITELLM_API_KEY ? check(`${endpoint}/health/readiness`, { authorization: `Bearer ${process.env.LITELLM_API_KEY}` }) : false,
  ]);
  return { ready: database && gateway, checks: { database, gateway } };
}

/** Keep private metrics separate from owner-authenticated release verification; neither claims Flux proof. */
export async function handleRuntimeRoute(req: IncomingMessage, res: ServerResponse, url: URL, headers: HeaderMap): Promise<boolean> {
  if (req.method !== "GET") return false;
  if (url.pathname === "/metrics") {
    const expected = process.env.METRICS_SCRAPE_BEARER_TOKEN || "";
    const supplied = typeof req.headers.authorization === "string" ? req.headers.authorization.replace(/^Bearer /, "") : "";
    const actual = Buffer.from(supplied), wanted = Buffer.from(expected);
    if (!expected || actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
      throw new HttpError(403, "METRICS_ACCESS_DENIED", "Collector bearer credential is required");
    }
    res.writeHead(200, { ...headers, "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
    res.end(runtimeMetrics());
    return true;
  }
  if (url.pathname === "/ready") {
    const result = await runtimeReadiness(); sendJson(res, result.ready ? 200 : 503, result, { ...headers, "cache-control": "no-store" }); return true;
  }
  if (url.pathname !== "/api/ops/revision") return false;
  const expected = process.env.PRODUCTION_VERIFY_TOKEN || "";
  const supplied = typeof req.headers.authorization === "string" ? req.headers.authorization.replace(/^Bearer /, "") : "";
  const actual = Buffer.from(supplied), wanted = Buffer.from(expected);
  if (!expected || actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new HttpError(403, "OPS_ACCESS_DENIED", "Owner verification credential is required");
  const revision = process.env.RELEASE_REVISION || "";
  const state = await runtimeReadiness();
  sendJson(res, state.ready && /^[a-f0-9]{40}$/.test(revision) ? 200 : 503, { revision: revision || null, ready: state.ready && /^[a-f0-9]{40}$/.test(revision), checks: state.checks, flux: { ready: null, reason: "VERIFY_WITH_OWNER_OPS_CLI" } }, { ...headers, "cache-control": "no-store" });
  return true;
}
