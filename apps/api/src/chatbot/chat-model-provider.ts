import { config } from "../config.js";
import { HttpError } from "../http.js";
import { asJsonObject, asString, isJsonObject, type JsonObject } from "../types.js";
import type { ChatModelTrace } from "./chatbot-types.js";

const MAX_BYTES = 256 * 1024;

/** Sanitized provider failure retaining only content-free execution measurements. */
export class ChatModelError extends HttpError {
  constructor(code: string, public readonly trace: ChatModelTrace[]) {
    super(502, code, "Support model verification could not be completed");
  }
}

const DEFAULT_FALLBACK_GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.1-flash-lite-preview",
] as const;

/** Collects provider output privately; partial, truncated or refused output never becomes a result. */
export async function requestChatJson(provider: "mistral" | "gemini", model: string, operation: ChatModelTrace["operation"], prompt: string): Promise<{ value: JsonObject; trace: ChatModelTrace }> {
  const gateway = Boolean(process.env.LITELLM_ENDPOINT?.trim() && process.env.LITELLM_API_KEY?.trim());
  // A provider without a configured key is skipped silently; no key at all fails closed later.
  const candidates: { provider: "mistral" | "gemini"; model: string }[] = [];
  const pushUnique = (nextProvider: "mistral" | "gemini", nextModel: string) => {
    const cleanModel = nextModel.trim();
    if (!cleanModel) return;
    if (!candidates.some((entry) => entry.provider === nextProvider && entry.model === cleanModel)) {
      candidates.push({ provider: nextProvider, model: cleanModel });
    }
  };
  if (provider === "mistral") {
    if (gateway || config.mistralApiKey) {
      pushUnique("mistral", model);
      pushUnique("gemini", config.geminiModel || DEFAULT_FALLBACK_GEMINI_MODELS[0]);
      for (const fallback of DEFAULT_FALLBACK_GEMINI_MODELS) pushUnique("gemini", fallback);
    } else if (gateway || config.geminiApiKey) {
      pushUnique("gemini", config.geminiModel || DEFAULT_FALLBACK_GEMINI_MODELS[0]);
      for (const fallback of DEFAULT_FALLBACK_GEMINI_MODELS) pushUnique("gemini", fallback);
    }
  } else if (gateway || config.geminiApiKey) {
    pushUnique("gemini", model);
    for (const fallback of DEFAULT_FALLBACK_GEMINI_MODELS) pushUnique("gemini", fallback);
  }
  // Cap candidate chain to 3 distinct quota pools so worst-case latency stays well within proxy deadlines.
  if (candidates.length > 3) candidates.splice(3);
  if (!candidates.length) throw new ChatModelError("CHAT_PROVIDER_UNVERIFIED", []);
  const traces: ChatModelTrace[] = [];
  // Single retry only when there is no fallback candidate; otherwise advance fast to keep latency well within proxy limits.
  const maxAttemptsPerCandidate = candidates.length > 1 ? 1 : 2;
  for (const candidate of candidates) {
    for (let attempt = 0; attempt < maxAttemptsPerCandidate; attempt++) {
      try {
        return await attemptChatJson(candidate.provider, candidate.model, operation, prompt);
      } catch (error) {
        if (error instanceof ChatModelError) traces.push(...error.trace);
        if (attempt + 1 < maxAttemptsPerCandidate) await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
  console.error("chat_provider_exhausted", { operation, candidates, traces });
  throw new ChatModelError("CHAT_PROVIDER_UNVERIFIED", traces);
}

async function attemptChatJson(provider: "mistral" | "gemini", model: string, operation: ChatModelTrace["operation"], prompt: string): Promise<{ value: JsonObject; trace: ChatModelTrace }> {
  const started = performance.now();
  const gateway = Boolean(process.env.LITELLM_ENDPOINT || process.env.LITELLM_API_KEY);
  const trace: ChatModelTrace = { provider, operation, transport: gateway ? "gateway" : "direct", requestedModel: model, model: null, latencyMs: 0, outcome: "unavailable", streamed: gateway || provider === "mistral" };
  const controller = new AbortController();
  const timeoutMs = operation === "response_review" ? 25000 : 20000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const endpoint = process.env.LITELLM_ENDPOINT?.trim();
    const key = gateway ? process.env.LITELLM_API_KEY?.trim() : provider === "mistral" ? config.mistralApiKey : config.geminiApiKey;
    if (!model.trim() || !key || (gateway && !endpoint) || (!gateway && (config.nodeEnv === "production" || process.env.AI_ALLOW_DIRECT_PROVIDER === "false"))) throw new Error("configuration");
    let url: string;
    if (gateway) {
      const base = new URL(endpoint!);
      if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("configuration");
      const path = endpoint!.replace(/\/+$/, "");
      url = `${path.endsWith("/v1") ? path : `${path}/v1`}/chat/completions`;
    } else {
      url = provider === "mistral" ? "https://api.mistral.ai/v1/chat/completions" : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    }
    const payload = trace.streamed ? {
      model, stream: true, temperature: 0, max_tokens: 3200, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }]
    } : {
      contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 3200, responseMimeType: "application/json" }
    };
    const response = await fetch(url, { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json", ...(trace.streamed ? { authorization: `Bearer ${key}` } : { "x-goog-api-key": key }) }, body: JSON.stringify(payload) });
    if (!response.ok) { trace.note = `HTTP_${response.status}`; await response.body?.cancel(); throw new Error("provider"); }
    trace.outcome = "invalid";
    let raw: string;
    if (trace.streamed) {
      if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) { await response.body?.cancel(); throw new Error("stream"); }
      raw = await collectStream(response, trace);
    } else {
      const data = parseObject(await collectBody(response));
      trace.model = safeIdentity(data.modelVersion);
      const candidate = asJsonObject(Array.isArray(data.candidates) ? data.candidates[0] : undefined);
      if (asJsonObject(data.promptFeedback).blockReason || candidate.finishReason !== "STOP") throw new Error("incomplete");
      const parts = asJsonObject(candidate.content).parts;
      const textParts = Array.isArray(parts)
        ? parts.filter((part) => isJsonObject(part) && part.thought !== true && typeof part.text === "string")
        : [];
      if (!textParts.length) throw new Error("parts");
      raw = textParts.map((part) => asString(asJsonObject(part).text)).join("");
    }
    const value = parseObject(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    trace.outcome = "ok";
    trace.latencyMs = Math.round(performance.now() - started);
    return { value, trace };
  } catch {
    if (controller.signal.aborted) trace.outcome = "unavailable";
    trace.latencyMs = Math.round(performance.now() - started);
    throw new ChatModelError("CHAT_PROVIDER_UNVERIFIED", [trace]);
  } finally { clearTimeout(timer); }
}

async function collectStream(response: Response, trace: ChatModelTrace): Promise<string> {
  if (!response.body) throw new Error("body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, buffer = "", output = "", completed = false, stopped = false;
  const event = (frame: string) => {
    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n").trim();
    if (!data) return;
    if (completed) throw new Error("trailing data");
    if (data === "[DONE]") { if (!stopped) throw new Error("unfinished"); completed = true; return; }
    const chunk = parseObject(data);
    if (chunk.error) throw new Error("provider");
    const identity = safeIdentity(chunk.model);
    if (identity) { if (trace.model && trace.model !== identity) throw new Error("model changed"); trace.model = identity; }
    if (!Array.isArray(chunk.choices)) throw new Error("choices");
    if (!chunk.choices.length) return;
    if (chunk.choices.length !== 1) throw new Error("choices");
    const choice = asJsonObject(chunk.choices[0]);
    if (choice.index !== 0) throw new Error("choice index");
    const delta = asJsonObject(choice.delta);
    if (delta.refusal || delta.tool_calls || delta.function_call) throw new Error("refused");
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== "string" || (stopped && delta.content)) throw new Error("content");
      output += delta.content;
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (choice.finish_reason !== "stop" || stopped) throw new Error("incomplete");
      stopped = true;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("size");
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) { event(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
    }
    buffer += decoder.decode();
    if (buffer.trim()) event(buffer.replace(/\r\n/g, "\n"));
    if (!completed || !stopped || !output.trim()) throw new Error("incomplete");
    return output;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

async function collectBody(response: Response): Promise<string> {
  if (!response.body) throw new Error("body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("size");
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function parseObject(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new Error("object");
  return value;
}
function safeIdentity(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value) ? value : null;
}
