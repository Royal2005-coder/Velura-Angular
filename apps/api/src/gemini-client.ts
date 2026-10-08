import { setTimeout as delay } from "node:timers/promises";
import { config } from "./config.js";
import { HttpError } from "./http.js";
import { asJsonObject, asString, isJsonObject, type JsonObject } from "./types.js";
import { normalizeOutputSchema, validateOutput } from "./ai-gateway-schema.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

/** Bounds the entire operation, including retries and response decoding, and supports caller cancellation. */
export interface GeminiRequestOptions {
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
}

/** Text embeddings are 1536-dimensional by default, independent of the CLIP image index. */
export interface GeminiEmbeddingOptions extends GeminiRequestOptions {
  dimensions?: number;
}

/** JSON output is parsed and checked locally against the supported schema subset. */
export interface GeminiJsonOptions extends GeminiRequestOptions {}

/** A user prompt may include bounded raster images in addition to text. */
export interface GeminiTextOptions extends GeminiRequestOptions {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  images?: ReadonlyArray<{ bytes: Buffer; mime: string }>;
}


/** Content-free measurements; cost is only included when the gateway supplies it. */
export interface AiGatewayMetric {
  operation: "text" | "json" | "vision" | "embedding";
  requests: number;
  failures: number;
  retries: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageMeasurements: number;
  costUsd: number;
  costMeasurements: number;
}
const metrics = new Map<AiGatewayMetric["operation"], AiGatewayMetric>();

/** Returns detached, content-free counters for the parent metrics endpoint. */
export function readAiGatewayMetrics(): AiGatewayMetric[] {
  return Array.from(metrics.values(), (metric) => ({ ...metric }));
}

/** Gateway configuration takes precedence; direct Gemini is an explicit development-only mode. */
export function isGeminiConfigured(): boolean {
  try { providerRoute(); return true; } catch { return false; }
}

/** Generates a finite text vector with exactly the requested number of dimensions. */
export async function generateGeminiEmbedding(text: unknown, options: GeminiEmbeddingOptions = {}): Promise<number[]> {
  const route = providerRoute();
  const model = options.model || config.geminiEmbeddingModel;
  const dimensions = options.dimensions ?? config.geminiEmbeddingDimensions ?? 1536;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192) throw new HttpError(400, "AI_DIMENSIONS_INVALID", "Embedding dimensions are invalid");
  const input = String(text ?? "").slice(0, 12000);
  const data = await providerRequest(route, route.gateway ? "/embeddings" : `/models/${encodeURIComponent(model)}:embedContent`, route.gateway
    ? { model, input, dimensions, encoding_format: "float" }
    : { content: { parts: [{ text: input }] }, output_dimensionality: dimensions }, options, "embedding");
  const object = asJsonObject(data);
  const values: unknown = route.gateway
    ? asJsonObject(Array.isArray(object.data) ? object.data[0] : undefined).embedding
    : asJsonObject(object.embedding).values;
  if (!Array.isArray(values) || values.length !== dimensions || values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new HttpError(502, "AI_EMBEDDING_INVALID", "AI embedding has invalid values or dimensions");
  }
  return values as number[];
}

/** Generates JSON with server-side schema validation; json_object is not a provider schema guarantee. */
export async function generateGeminiJson(prompt: unknown, schema: unknown, options: GeminiJsonOptions = {}): Promise<unknown> {
  return generateJson(String(prompt ?? "").slice(0, 30000), schema, options, undefined);
}

/** Generates structured image analysis through the same configured gateway and deadline policy. */
export async function generateGeminiVisionJson(prompt: string, bytes: Buffer, mime: string, schema: unknown, options: { model?: string; signal?: AbortSignal; timeoutMs?: number; maxRetries?: number } = {}): Promise<unknown> {
  validateImage(bytes, mime);
  return generateJson(prompt.slice(0, 30000), schema, options, { bytes, mime });
}

async function generateJson(prompt: string, inputSchema: unknown, options: GeminiJsonOptions, image: { bytes: Buffer; mime: string } | undefined): Promise<unknown> {
  const schema = normalizeOutputSchema(inputSchema);
  const route = providerRoute();
  const model = options.model || config.geminiStylistModel;
  const images = image ? [image] : [];
  const payload = route.gateway ? {
    model,
    messages: [{ role: "system", content: `Return only JSON matching this schema: ${JSON.stringify(schema)}` }, { role: "user", content: openAiContent(prompt, images) }],
    response_format: { type: "json_object" }
  } : {
    contents: [{ parts: geminiParts(prompt, images) }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema }
  };
  const data = await providerRequest(route, route.gateway ? "/chat/completions" : `/models/${encodeURIComponent(model)}:generateContent`, payload, options, image ? "vision" : "json");
  const text = responseText(data, route.gateway);
  let decoded: unknown;
  try { decoded = JSON.parse(text) as unknown; } catch { throw new HttpError(502, "AI_JSON_INVALID", "AI returned invalid JSON"); }
  validateOutput(decoded, schema);
  return decoded;
}

/** Generates plain text, optionally with validated image attachments, without provider bypass. */
export async function generateGeminiText(prompt: unknown, options: GeminiTextOptions = {}): Promise<string> {
  const route = providerRoute();
  const model = options.model || config.geminiModel || config.geminiStylistModel;
  const images = options.images ?? [];
  if (images.length > 4 || images.reduce((sum, image) => sum + image.bytes.length, 0) > MAX_IMAGE_BYTES) throw new HttpError(413, "AI_IMAGE_TOO_LARGE", "AI image attachments exceed the byte limit");
  for (const image of images) validateImage(image.bytes, image.mime);
  const text = String(prompt ?? "").slice(0, 30000);
  const generation = { temperature: options.temperature ?? 0.35, topP: options.topP ?? 0.9, maxOutputTokens: options.maxOutputTokens ?? 1600 };
  const payload = route.gateway
    ? { model, messages: [{ role: "user", content: openAiContent(text, images) }], temperature: generation.temperature, top_p: generation.topP, max_tokens: generation.maxOutputTokens }
    : { contents: [{ role: "user", parts: geminiParts(text, images) }], generationConfig: generation };
  const data = await providerRequest(route, route.gateway ? "/chat/completions" : `/models/${encodeURIComponent(model)}:generateContent`, payload, options, images.length ? "vision" : "text");
  return responseText(data, route.gateway);
}

/** Describes a chatbot attachment; invalid bytes never reach the provider. */
export async function analyzeImageWithGemini(base64Data: string, mimeType: string, userPrompt: string): Promise<string> {
  const bytes = decodeImage(base64Data, mimeType);
  return generateGeminiText(userPrompt || "Hãy mô tả hình ảnh, đặc biệt phom dáng, màu sắc và phong cách thời trang.", { images: [{ bytes, mime: mimeType }] });
}


/** Formats only finite vectors for PostgREST, without coercing malformed provider values. */
export function vectorLiteral(values: unknown): string {
  if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new HttpError(500, "INVALID_VECTOR", "Embedding vector is invalid");
  return `[${values.map((value: number) => value.toFixed(8)).join(",")}]`;
}

interface ProviderRoute { gateway: boolean; base: string; key: string; }
function providerRoute(): ProviderRoute {
  const endpoint = process.env.LITELLM_ENDPOINT?.trim();
  const key = process.env.LITELLM_API_KEY?.trim();
  if (endpoint || key) {
    if (!endpoint || !key) throw new HttpError(503, "AI_GATEWAY_CONFIG_INVALID", "AI gateway endpoint and application key are required");
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new HttpError(503, "AI_GATEWAY_CONFIG_INVALID", "AI gateway endpoint is invalid"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HttpError(503, "AI_GATEWAY_CONFIG_INVALID", "AI gateway endpoint is invalid");
    const base = endpoint.replace(/\/+$/, "");
    return { gateway: true, base: base.endsWith("/v1") ? base : `${base}/v1`, key };
  }
  if (config.nodeEnv === "production" || process.env.AI_ALLOW_DIRECT_PROVIDER !== "true") throw new HttpError(503, "AI_GATEWAY_REQUIRED", "AI gateway is required");
  if (!config.geminiApiKey) throw new HttpError(503, "AI_PROVIDER_KEY_REQUIRED", "Development Gemini provider is not configured");
  return { gateway: false, base: GEMINI_API_BASE, key: config.geminiApiKey };
}

async function providerRequest(route: ProviderRoute, path: string, payload: JsonObject | FormData, options: GeminiRequestOptions, operation: AiGatewayMetric["operation"]): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? config.requestTimeoutMs ?? 15000;
  const retries = options.maxRetries ?? 2;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isInteger(retries) || retries < 0 || retries > 5) throw new HttpError(400, "AI_REQUEST_OPTIONS_INVALID", "AI deadline or retry options are invalid");
  const started = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const metric = metrics.get(operation) ?? { operation, requests: 0, failures: 0, retries: 0, latencyMs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, usageMeasurements: 0, costUsd: 0, costMeasurements: 0 };
  metrics.set(operation, metric);
  metric.requests++;
  const multipart = payload instanceof FormData;
  const body = multipart ? payload : JSON.stringify(payload);
  try {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${route.base}${path}`, { method: "POST", redirect: "error", headers: { ...(multipart ? {} : { "content-type": "application/json" }), ...(route.gateway ? { authorization: `Bearer ${route.key}` } : { "x-goog-api-key": route.key }) }, body, signal: controller.signal });
      } catch {
        if (controller.signal.aborted) throw abortError(timedOut);
        if (attempt >= retries) throw new HttpError(502, "AI_PROVIDER_UNAVAILABLE", "AI provider is unavailable");
        metric.retries++;
        await delay(250 * (attempt + 1), undefined, { signal: controller.signal });
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const retryable = [429, 500, 502, 503, 504].includes(response.status);
        if (retryable && attempt < retries) {
          metric.retries++;
          const retryAfter = Number(response.headers.get("retry-after"));
          const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10000) : 250 * (attempt + 1);
          await delay(pause, undefined, { signal: controller.signal });
          continue;
        }
        throw providerStatusError(response.status);
      }
      const text = await boundedResponse(response);
      let data: unknown;
      try { data = JSON.parse(text) as unknown; } catch { throw new HttpError(502, "AI_RESPONSE_INVALID", "AI provider returned invalid response JSON"); }
      if (!isJsonObject(data)) throw new HttpError(502, "AI_RESPONSE_INVALID", "AI provider returned an invalid response");
      if (!route.gateway && asString(asJsonObject(data.promptFeedback).blockReason)) throw new HttpError(422, "AI_SAFETY_BLOCK", "AI provider declined the request");
      recordUsage(metric, data, response);
      if (performance.now() - started >= timeoutMs) throw abortError(true);
      if (options.signal?.aborted) throw abortError(false);
      return data;
    }
  } catch (error: unknown) {
    metric.failures++;
    if (controller.signal.aborted) throw abortError(timedOut);
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "AI_PROVIDER_UNAVAILABLE", "AI provider is unavailable");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    metric.latencyMs += performance.now() - started;
  }
}

async function boundedResponse(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new HttpError(502, "AI_RESPONSE_TOO_LARGE", "AI provider response exceeds the byte limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) throw new HttpError(502, "AI_RESPONSE_TOO_LARGE", "AI provider response exceeds the byte limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function providerStatusError(status: number): HttpError {
  if (status === 401 || status === 403) return new HttpError(503, "AI_PROVIDER_UNAUTHORIZED", "AI provider authorization failed");
  if (status === 429) return new HttpError(429, "AI_PROVIDER_RATE_LIMITED", "AI provider rate limit reached");
  if (status === 404 || status === 405 || status === 501) return new HttpError(503, "AI_PROVIDER_UNSUPPORTED", "AI provider does not support the configured operation or model");
  if (status >= 400 && status < 500) return new HttpError(502, "AI_PROVIDER_REJECTED", "AI provider rejected the request");
  return new HttpError(502, "AI_PROVIDER_UNAVAILABLE", "AI provider is unavailable");
}
function abortError(timedOut: boolean): HttpError {
  return timedOut ? new HttpError(504, "AI_TIMEOUT", "AI request exceeded its total deadline") : new HttpError(499, "AI_CANCELLED", "AI request was cancelled");
}

function recordUsage(metric: AiGatewayMetric, data: JsonObject, response: Response): void {
  const usage = asJsonObject(data.usage || data.usageMetadata);
  const prompt = usage.prompt_tokens ?? usage.promptTokenCount;
  const completion = usage.completion_tokens ?? usage.candidatesTokenCount;
  const total = usage.total_tokens ?? usage.totalTokenCount;
  if ([prompt, completion, total].some((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    metric.usageMeasurements++;
    for (const [field, value] of [["promptTokens", prompt], ["completionTokens", completion], ["totalTokens", total]] as const) if (typeof value === "number" && Number.isFinite(value) && value >= 0) metric[field] += value;
  }
  const header = response.headers.get("x-litellm-response-cost");
  const cost = header === null ? NaN : Number(header);
  if (Number.isFinite(cost) && cost >= 0) { metric.costUsd += cost; metric.costMeasurements++; }
}

function responseText(data: unknown, gateway: boolean): string {
  let text = "";
  if (gateway) {
    const choices = asJsonObject(data).choices;
    const choice = asJsonObject(Array.isArray(choices) ? choices[0] : undefined);
    if (choice.finish_reason === "length") throw new HttpError(502, "AI_OUTPUT_TRUNCATED", "AI output was truncated");
    const message = asJsonObject(choice.message);
    if (message.refusal || choice.finish_reason === "content_filter") throw new HttpError(422, "AI_SAFETY_BLOCK", "AI provider declined the request");
    text = asString(message.content);
  } else {
    const candidates = asJsonObject(data).candidates;
    const first = asJsonObject(Array.isArray(candidates) ? candidates[0] : undefined);
    if (first.finishReason === "MAX_TOKENS") throw new HttpError(502, "AI_OUTPUT_TRUNCATED", "AI output was truncated");
    text = candidateParts(data).map((part) => asString(part.text)).join("");
  }
  if (!text.trim()) throw new HttpError(502, "AI_TEXT_EMPTY", "AI provider returned empty text");
  return text.trim();
}
function candidateParts(data: unknown): JsonObject[] {
  const candidates = asJsonObject(data).candidates;
  const content = asJsonObject(asJsonObject(Array.isArray(candidates) ? candidates[0] : undefined).content);
  return Array.isArray(content.parts) ? content.parts.map(asJsonObject) : [];
}
function openAiContent(prompt: string, images: ReadonlyArray<{ bytes: Buffer; mime: string }>): unknown {
  return images.length ? [{ type: "text", text: prompt }, ...images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.bytes.toString("base64")}` } }))] : prompt;
}
function geminiParts(prompt: string, images: ReadonlyArray<{ bytes: Buffer; mime: string }>): JsonObject[] {
  return [{ text: prompt }, ...images.map((image) => ({ inlineData: { mimeType: image.mime, data: image.bytes.toString("base64") } }))];
}
function decodeBase64(value: string): Buffer {
  if (!value || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new HttpError(400, "AI_IMAGE_INVALID", "AI image base64 is invalid or exceeds the byte limit");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new HttpError(400, "AI_IMAGE_INVALID", "AI image base64 is invalid");
  return bytes;
}
function decodeImage(value: string, mime: string): Buffer {
  const prefix = /^data:([^;]+);base64,/.exec(value);
  if (prefix && prefix[1] !== mime) throw new HttpError(400, "AI_IMAGE_MIME_INVALID", "AI image MIME does not match its data URL");
  const bytes = decodeBase64(prefix ? value.slice(prefix[0].length) : value);
  validateImage(bytes, mime);
  return bytes;
}
function validateImage(bytes: Buffer, mime: string): void {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "AI_IMAGE_TOO_LARGE", "AI image is empty or exceeds the byte limit");
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime) || rasterMime(bytes) !== mime) throw new HttpError(400, "AI_IMAGE_MIME_INVALID", "AI image must be a matching JPEG, PNG or WebP raster");
}
function rasterMime(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "";
}
