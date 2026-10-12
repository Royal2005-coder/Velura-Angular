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

/** Collects provider output privately; partial, truncated or refused output never becomes a result. */
export async function requestChatJson(provider: "mistral" | "gemini", model: string, operation: ChatModelTrace["operation"], prompt: string): Promise<{ value: JsonObject; trace: ChatModelTrace }> {
  const candidates: { provider: "mistral" | "gemini"; model: string }[] = [{ provider, model }];
  if (provider === "mistral") {
    candidates.push({ provider: "gemini", model: "gemini-3.5-flash-lite" });
    const geminiFallback = config.geminiModel || "gemini-3.5-flash-lite";
    if (geminiFallback !== "gemini-3.5-flash-lite") {
      candidates.push({ provider: "gemini", model: geminiFallback });
    }
  } else if (model !== "gemini-3.5-flash-lite") {
    candidates.push({ provider: "gemini", model: "gemini-3.5-flash-lite" });
  }
  const traces: ChatModelTrace[] = [];
  for (const candidate of candidates) {
    try {
      return await attemptChatJson(candidate.provider, candidate.model, operation, prompt);
    } catch (error) {
      if (error instanceof ChatModelError) traces.push(...error.trace);
    }
  }
  throw new ChatModelError("CHAT_PROVIDER_UNVERIFIED", traces);
}

async function attemptChatJson(provider: "mistral" | "gemini", model: string, operation: ChatModelTrace["operation"], prompt: string): Promise<{ value: JsonObject; trace: ChatModelTrace }> {
  const started = performance.now();
  const gateway = Boolean(process.env.LITELLM_ENDPOINT || process.env.LITELLM_API_KEY);
  const trace: ChatModelTrace = { provider, operation, transport: gateway ? "gateway" : "direct", requestedModel: model, model: null, latencyMs: 0, outcome: "unavailable", streamed: gateway || provider === "mistral" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
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
    if (!response.ok) { await response.body?.cancel(); throw new Error("provider"); }
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
