/**
 * Unified Gemini Decision Client (`gemini-decision-1` via `POST /v1beta/decisions`).
 *
 * Implements:
 * 1. Primary Key -> Circuit Breaker -> Secondary Free-Tier Key (`GEMINI_FALLBACK_FREE_KEY` or local `gemini.env`)
 * 2. Zero-output-token parallel evaluation (`noul`, `choice`, `score`)
 * 3. Deterministic `temperature: 0.0` Structured Output JSON fallback when running behind an OpenAI-only proxy
 * 4. Content-free telemetry counters + non-blocking audit persistence to `public.ai_decision_log`
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { HttpError } from "../http.js";
import { insertRow } from "../supabase.js";
import { asJsonObject, asNumber, asString, isJsonObject, type JsonObject } from "../types.js";
import { normalizeOutputSchema, validateOutput } from "../ai-gateway-schema.js";
import type {
  CreateDecisionRequest,
  CreateDecisionResult,
  DecisionAnswer,
  DecisionChoiceQuestion,
  DecisionEngineMetric,
  DecisionInputBlock,
  DecisionQuestion,
  DecisionRolloutMode,
  DecisionScoreQuestion,
  DecisionTransport,
  DecisionUseCase,
} from "./decision-types.js";

const GEMINI_V1BETA_BASE = "https://generativelanguage.googleapis.com/v1beta";
const CIRCUIT_COOLDOWN_MS = 60_000;
const QUESTION_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const decisionMetrics = new Map<DecisionUseCase, DecisionEngineMetric>();
let primaryCircuitOpenUntil = 0;
let cachedLocalEnvKey: { path: string; key: string } | null = null;

/** Reads detached, content-free Prometheus metrics for all Decision Engine use-cases. */
export function readDecisionEngineMetrics(): DecisionEngineMetric[] {
  return Array.from(decisionMetrics.values(), (m) => ({ ...m }));
}

/** Resets in-memory circuit breaker and metrics during unit tests. */
export function resetDecisionClientStateForTest(): void {
  primaryCircuitOpenUntil = 0;
  cachedLocalEnvKey = null;
  decisionMetrics.clear();
}

/**
 * Safely resolves the secondary fallback Gemini API key from environment variables or a local
 * `.gitignore`-protected fallback file (`LOCAL_GEMINI_ENV_PATH` or `gemini.env` in non-production).
 * Supports both `GEMINI_API_KEY=...` lines and single-line raw `AQ...` / `AIza...` keys.
 * Never logs or exposes key material.
 */
export function resolveFallbackGeminiKey(): string {
  const explicitEnv = (
    config.geminiFallbackApiKey ||
    process.env.GEMINI_FALLBACK_FREE_KEY ||
    process.env.GEMINI_DECISION_FALLBACK_KEY ||
    ""
  ).trim();
  if (explicitEnv) return explicitEnv;

  const configuredPath = (process.env.LOCAL_GEMINI_ENV_PATH || config.localGeminiEnvPath || "").trim();
  const inNodeTestRunner = Boolean(process.env.NODE_TEST_CONTEXT);
  const allowImplicitLocalFile =
    config.nodeEnv !== "production" &&
    process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK !== "false" &&
    (!inNodeTestRunner || process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK === "true");
  const candidatePaths = configuredPath
    ? [resolve(process.cwd(), configuredPath)]
    : allowImplicitLocalFile
      ? [
          resolve(process.cwd(), "gemini.env"),
          resolve(process.cwd(), "apps", "gemini.env"),
          resolve(process.cwd(), "..", "gemini.env"),
          resolve(process.cwd(), "..", "..", "gemini.env"),
        ]
      : [];

  if (candidatePaths.length === 0) return "";
  const cacheKey = candidatePaths.join("|");
  if (cachedLocalEnvKey && cachedLocalEnvKey.path === cacheKey) {
    return cachedLocalEnvKey.key;
  }

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) continue;
    try {
      const rawContent = readFileSync(candidatePath, "utf8");
      const parsed = parseKeyFromEnvContent(rawContent);
      if (parsed) {
        cachedLocalEnvKey = { path: cacheKey, key: parsed };
        return parsed;
      }
    } catch {
      // Ignore unreadable candidate and continue to next fallback path
    }
  }
  cachedLocalEnvKey = { path: cacheKey, key: "" };
  return "";
}

/** Parses a Gemini API key from either `.env` key-value pairs or a single raw key line. */
export function parseKeyFromEnvContent(rawContent: string): string {
  const lines = rawContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  for (const line of lines) {
    const kvMatch = /^(?:GEMINI_FALLBACK_FREE_KEY|GEMINI_DECISION_FALLBACK_KEY|GEMINI_PRIMARY_KEY|GEMINI_API_KEY|API_KEY)\s*=\s*(.+)$/i.exec(line);
    if (kvMatch?.[1]) {
      return stripWrappingQuotes(kvMatch[1].trim());
    }
  }

  for (const line of lines) {
    if (!line.includes("=") && /^[A-Za-z0-9._-]{20,256}$/.test(line)) {
      return line;
    }
  }
  return "";
}

function stripWrappingQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/** Determines whether at least one Decision Engine route (primary, fallback key, or LiteLLM gateway) is configured. */
export function isDecisionEngineConfigured(): boolean {
  if (Boolean(process.env.LITELLM_ENDPOINT?.trim() && process.env.LITELLM_API_KEY?.trim())) return true;
  if (config.geminiApiKey.trim()) return true;
  if (resolveFallbackGeminiKey()) return true;
  return false;
}

/** Computes effective rollout mode (`active`, `canary`, or `shadow`) for deterministic rollout gating. */
export function resolveRolloutMode(seed = ""): { mode: DecisionRolloutMode; activeForRequest: boolean } {
  const rawMode = (process.env.AI_DECISION_ROLLOUT_MODE || config.aiDecisionRolloutMode || "active")
    .trim()
    .toLowerCase();
  if (rawMode === "shadow") {
    return { mode: "shadow", activeForRequest: false };
  }
  if (rawMode === "canary") {
    const pct = Math.max(0, Math.min(100, Number(process.env.AI_DECISION_CANARY_PERCENT ?? config.aiDecisionCanaryPercent ?? 100)));
    const bucket = deterministicBucket(seed || String(Date.now()));
    return { mode: "canary", activeForRequest: bucket < pct };
  }
  return { mode: "active", activeForRequest: true };
}

function deterministicBucket(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

/**
 * Evaluates a batch of typed questions (`noul`, `choice`, `score`) against a shared text/multimodal input.
 * Uses `gemini-decision-1` (`POST /v1beta/decisions`) with automatic circuit-breaker failover to the
 * secondary key (`gemini.env` / `GEMINI_FALLBACK_FREE_KEY`), then falls back to `temperature: 0.0`
 * structured JSON schema evaluation if `/v1beta/decisions` is unreachable.
 */
export async function evaluateGeminiDecisions(
  request: CreateDecisionRequest,
  customFetch: typeof fetch = globalThis.fetch,
): Promise<CreateDecisionResult> {
  validateDecisionRequest(request);

  const started = performance.now();
  const timeoutMs = Math.max(500, Math.min(60_000, request.timeoutMs ?? config.geminiDecisionTimeoutMs ?? 8000));
  const decisionModel = (config.geminiDecisionModel || "gemini-decision-1").trim();
  const rollout = resolveRolloutMode(request.entityId || request.useCase);

  const primaryKey = (process.env.GEMINI_PRIMARY_KEY || config.geminiApiKey || "").trim();
  const fallbackKey = resolveFallbackGeminiKey();
  const now = Date.now();

  const metric = getOrCreateMetric(request.useCase);
  metric.requests++;

  let lastError: unknown = null;

  // Tier 1: Primary Gemini API Key -> POST /v1beta/decisions (skipped while circuit breaker is open)
  if (primaryKey && now >= primaryCircuitOpenUntil) {
    try {
      const res = await callDecisionsEndpoint({
        apiKey: primaryKey,
        model: decisionModel,
        input: request.input,
        questions: request.questions,
        timeoutMs,
        signal: request.signal,
        customFetch,
      });
      const latencyMs = Math.max(1, Math.round(performance.now() - started));
      metric.latencyMs += latencyMs;
      metric.inputTokens += res.inputTokens;
      return {
        answers: res.answers,
        modelUsed: decisionModel,
        transport: "decisions_api",
        usedFallbackKey: false,
        rolloutMode: rollout.mode,
        latencyMs,
        inputTokens: res.inputTokens,
      };
    } catch (err: unknown) {
      lastError = err;
      if (isAbortError(err, request.signal)) {
        metric.failures++;
        throw err;
      }
      if (shouldTripCircuit(err)) {
        primaryCircuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      }
    }
  }

  // Tier 2: Secondary Free-Tier Fallback Key (`GEMINI_FALLBACK_FREE_KEY` / `gemini.env`) -> POST /v1beta/decisions
  if (fallbackKey && fallbackKey !== primaryKey) {
    try {
      const res = await callDecisionsEndpoint({
        apiKey: fallbackKey,
        model: decisionModel,
        input: request.input,
        questions: request.questions,
        timeoutMs,
        signal: request.signal,
        customFetch,
      });
      const latencyMs = Math.max(1, Math.round(performance.now() - started));
      metric.fallbackKeyCount++;
      metric.latencyMs += latencyMs;
      metric.inputTokens += res.inputTokens;
      return {
        answers: res.answers,
        modelUsed: decisionModel,
        transport: "fallback_decisions_api",
        usedFallbackKey: true,
        rolloutMode: rollout.mode,
        latencyMs,
        inputTokens: res.inputTokens,
      };
    } catch (err: unknown) {
      lastError = err;
      if (isAbortError(err, request.signal)) {
        metric.failures++;
        throw err;
      }
    }
  }

  // Tier 3: Structured Output (`temperature: 0.0` + strict `responseSchema`) over LiteLLM Gateway or available Gemini keys/models
  const structuredRoutes = listGenerativeRoutes(primaryKey, fallbackKey);
  for (const structuredRoute of structuredRoutes) {
    try {
      const res = await callStructuredDecisionFallback({
        route: structuredRoute,
        input: request.input,
        questions: request.questions,
        timeoutMs: Math.max(timeoutMs, 10_000),
        signal: request.signal,
        customFetch,
      });
      const latencyMs = Math.max(1, Math.round(performance.now() - started));
      metric.structuredFallbackCount++;
      if (structuredRoute.usedFallbackKey) metric.fallbackKeyCount++;
      metric.latencyMs += latencyMs;
      metric.inputTokens += res.inputTokens;
      return {
        answers: res.answers,
        modelUsed: res.modelUsed,
        transport: "structured_json_fallback",
        usedFallbackKey: structuredRoute.usedFallbackKey,
        rolloutMode: rollout.mode,
        latencyMs,
        inputTokens: res.inputTokens,
      };
    } catch (err: unknown) {
      lastError = err;
      if (isAbortError(err, request.signal)) break;
    }
  }

  metric.failures++;
  if (lastError instanceof HttpError) throw lastError;
  throw new HttpError(503, "AI_DECISION_UNAVAILABLE", "Hệ thống phân tích quyết định AI tạm thời không khả dụng.");
}

/**
 * Generates structured JSON using Primary Key, LiteLLM Gateway, or the Secondary Fallback Key (`gemini.env`)
 * for generative layers (such as AI Blog End-to-End Content & Topic Discovery) after Decision routing.
 */
export async function generateFallbackAwareJson(
  prompt: string,
  rawSchema: JsonObject,
  options: { model?: string; temperature?: number; maxOutputTokens?: number; timeoutMs?: number; signal?: AbortSignal; customFetch?: typeof fetch } = {},
): Promise<{ data: JsonObject; modelUsed: string; usedFallbackKey: boolean }> {
  const schema = normalizeOutputSchema(rawSchema);
  const primaryKey = (process.env.GEMINI_PRIMARY_KEY || config.geminiApiKey || "").trim();
  const fallbackKey = resolveFallbackGeminiKey();
  const customFetch = options.customFetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const temperature = options.temperature ?? 0.25;
  const maxOutputTokens = options.maxOutputTokens ?? 4096;
  const requestedModel = resolveGenerativeModelName(options.model || config.geminiModel || "gemini-2.5-flash");

  const routes = listGenerativeRoutes(primaryKey, fallbackKey);
  if (!routes.length) {
    throw new HttpError(503, "AI_PROVIDER_KEY_REQUIRED", "Chưa cấu hình khóa AI cho hệ thống sinh nội dung.");
  }

  let lastError: unknown = null;
  for (const route of routes) {
    const modelCandidates = route.gateway
      ? [requestedModel]
      : resolveGenerativeModelCandidates(requestedModel);
    for (const candidateModel of modelCandidates) {
      try {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        if (options.signal?.aborted) controller.abort();
        else options.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const url = route.gateway
            ? `${route.base}/chat/completions`
            : `${GEMINI_V1BETA_BASE}/models/${encodeURIComponent(candidateModel)}:generateContent`;
          const body = route.gateway
            ? {
                model: candidateModel,
                temperature,
                max_tokens: maxOutputTokens,
                response_format: { type: "json_object" },
                messages: [
                  { role: "system", content: `Return strictly valid JSON matching this schema: ${JSON.stringify(schema)}` },
                  { role: "user", content: prompt.slice(0, 30_000) },
                ],
              }
            : {
                contents: [{ role: "user", parts: [{ text: prompt.slice(0, 30_000) }] }],
                generationConfig: {
                  temperature,
                  maxOutputTokens,
                  responseMimeType: "application/json",
                  responseSchema: stripUnsupportedGeminiSchemaKeys(schema),
                },
              };

          const response = await customFetch(url, {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              ...(route.gateway ? { authorization: `Bearer ${route.key}` } : { "x-goog-api-key": route.key }),
            },
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            await response.body?.cancel();
            const mapped = mapStatusToHttpError(response.status);
            if (mapped.code === "AI_PROVIDER_UNAUTHORIZED" || mapped.code === "AI_PROVIDER_REJECTED") {
              lastError = mapped;
              break; // Invalid key on this route; move to next route immediately
            }
            throw mapped;
          }
          const payload = asJsonObject(await response.json());
          const text = extractGeneratedText(payload, route.gateway);
          const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
          const decoded: unknown = JSON.parse(cleaned);
          validateOutput(decoded, schema);
          return { data: asJsonObject(decoded), modelUsed: candidateModel, usedFallbackKey: route.usedFallbackKey };
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        }
      } catch (err: unknown) {
        lastError = err;
        if (isAbortError(err, options.signal)) throw err;
      }
    }
  }
  if (lastError instanceof HttpError) throw lastError;
  throw new HttpError(502, "AI_GENERATION_FAILED", "Không thể sinh nội dung AI tại thời điểm này.");
}

/**
 * Generates a 1536-dimensional semantic vector using Primary Key, LiteLLM Gateway, or Fallback Key (`gemini.env`),
 * automatically trying `gemini-embedding-2` then `gemini-embedding-001` if needed.
 */
export async function generateFallbackAwareEmbedding(
  text: string,
  options: { dimensions?: number; timeoutMs?: number; customFetch?: typeof fetch } = {},
): Promise<{ embedding: number[]; modelUsed: string; usedFallbackKey: boolean }> {
  const dimensions = options.dimensions ?? config.geminiEmbeddingDimensions ?? 1536;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const customFetch = options.customFetch ?? globalThis.fetch;
  const primaryKey = (process.env.GEMINI_PRIMARY_KEY || config.geminiApiKey || "").trim();
  const fallbackKey = resolveFallbackGeminiKey();
  const routes = listGenerativeRoutes(primaryKey, fallbackKey);
  const models = Array.from(new Set([config.geminiEmbeddingModel || "gemini-embedding-2", "gemini-embedding-001"]));

  for (const route of routes) {
    for (const model of models) {
      try {
        const url = route.gateway
          ? `${route.base}/embeddings`
          : `${GEMINI_V1BETA_BASE}/models/${encodeURIComponent(model)}:embedContent`;
        const body = route.gateway
          ? { model, input: text.slice(0, 8000), dimensions, encoding_format: "float" }
          : { content: { parts: [{ text: text.slice(0, 8000) }] }, output_dimensionality: dimensions };
        const response = await customFetch(url, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            "content-type": "application/json",
            ...(route.gateway ? { authorization: `Bearer ${route.key}` } : { "x-goog-api-key": route.key }),
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          await response.body?.cancel();
          continue;
        }
        const payload = asJsonObject(await response.json());
        const values = route.gateway
          ? asJsonObject(Array.isArray(payload.data) ? payload.data[0] : undefined).embedding
          : asJsonObject(payload.embedding).values;
        if (
          Array.isArray(values) &&
          values.length === dimensions &&
          values.every((v) => typeof v === "number" && Number.isFinite(v))
        ) {
          return { embedding: values as number[], modelUsed: model, usedFallbackKey: route.usedFallbackKey };
        }
      } catch {
        // Continue to next candidate model or fallback key
      }
    }
  }
  throw new HttpError(503, "AI_EMBEDDING_UNAVAILABLE", "Không thể tạo vector ngữ nghĩa sản phẩm.");
}

/** Records a decision audit entry asynchronously without blocking the user response if DB is offline. */
export async function recordDecisionAuditLog(entry: {
  useCase: DecisionUseCase;
  entityType?: string;
  entityId?: string;
  rolloutMode: DecisionRolloutMode;
  modelUsed: string;
  transport: DecisionTransport;
  usedFallbackKey: boolean;
  latencyMs: number;
  inputTokens: number;
  confidenceScore: number;
  requiresHumanReview: boolean;
  verdictCode: string;
  rawAnswers: JsonObject;
  downstreamAction: string;
  actorId?: string | null;
}): Promise<void> {
  const metric = getOrCreateMetric(entry.useCase);
  if (entry.requiresHumanReview) metric.humanReviewCount++;

  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) return;
  try {
    await insertRow("ai_decision_log", {
      use_case: entry.useCase,
      entity_type: entry.entityType || null,
      entity_id: entry.entityId || null,
      rollout_mode: entry.rolloutMode,
      model_used: entry.modelUsed,
      transport: entry.transport,
      used_fallback_key: entry.usedFallbackKey,
      latency_ms: Math.max(0, Math.round(entry.latencyMs)),
      input_tokens: Math.max(0, Math.round(entry.inputTokens)),
      confidence_score: Number(Math.max(0, Math.min(1, entry.confidenceScore)).toFixed(4)),
      requires_human_review: entry.requiresHumanReview,
      verdict_code: entry.verdictCode,
      raw_answers: entry.rawAnswers,
      downstream_action: entry.downstreamAction,
      actor_id: entry.actorId && /^[0-9a-f-]{36}$/i.test(entry.actorId) ? entry.actorId : null,
    });
  } catch {
    // Non-blocking telemetry persistence: never fail user workflow if migration 133 is pending
  }
}

// ============================================================================
// Internal Wire Protocol Helpers for `/v1beta/decisions`
// ============================================================================

async function callDecisionsEndpoint(args: {
  apiKey: string;
  model: string;
  input: string | readonly DecisionInputBlock[];
  questions: Readonly<Record<string, DecisionQuestion>>;
  timeoutMs: number;
  signal?: AbortSignal;
  customFetch: typeof fetch;
}): Promise<{ answers: Record<string, DecisionAnswer>; inputTokens: number }> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (args.signal?.aborted) controller.abort();
  else args.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, args.timeoutMs);

  try {
    const response = await args.customFetch(`${GEMINI_V1BETA_BASE}/decisions`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": args.apiKey,
      },
      body: JSON.stringify({
        model: args.model,
        input: args.input,
        questions: args.questions,
      }),
    });

    if (!response.ok) {
      let blockCode = "";
      if (response.status === 400) {
        const errBody = asJsonObject(await response.json().catch(() => ({})));
        blockCode = asString(asJsonObject(errBody.error).code);
      } else {
        await response.body?.cancel();
      }
      if (["safety", "prohibited_content", "blocklist", "image_safety", "content_blocked"].includes(blockCode)) {
        throw new HttpError(422, "AI_SAFETY_BLOCK", "Nội dung đầu vào bị bộ lọc an toàn từ chối.");
      }
      throw mapStatusToHttpError(response.status);
    }

    const payload = asJsonObject(await response.json());
    const promptFeedback = asJsonObject(payload.prompt_feedback || payload.promptFeedback);
    if (asString(promptFeedback.block_reason || promptFeedback.blockReason)) {
      throw new HttpError(422, "AI_SAFETY_BLOCK", "Nội dung đầu vào bị bộ lọc an toàn từ chối.");
    }

    const rawAnswers = asJsonObject(payload.answers);
    const parsedAnswers = parseAndValidateDecisionAnswers(args.questions, rawAnswers);
    const usage = asJsonObject(payload.usage);
    const inputTokens = Math.max(0, Math.round(asNumber(usage.total_input_tokens ?? usage.total_tokens) || 0));

    return { answers: parsedAnswers, inputTokens };
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      throw timedOut
        ? new HttpError(504, "AI_DECISION_TIMEOUT", "Quá thời gian phản hồi từ Decision Model.")
        : new HttpError(499, "AI_CANCELLED", "Yêu cầu phân tích AI đã bị hủy.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", onAbort);
  }
}

function parseAndValidateDecisionAnswers(
  questions: Readonly<Record<string, DecisionQuestion>>,
  rawAnswers: JsonObject,
): Record<string, DecisionAnswer> {
  const result: Record<string, DecisionAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const ans = asJsonObject(rawAnswers[key]);
    if (question.type === "noul") {
      const noul = clampProb(asNumber(ans.noul));
      const confidence = clampProb(asNumber(ans.confidence) || Math.max(noul, 1 - noul));
      result[key] = { type: "noul", noul, confidence };
    } else if (question.type === "choice") {
      const options = Object.keys(question.criteria);
      const rawProbs = asJsonObject(ans.probabilities);
      const probabilities: Record<string, number> = {};
      for (const opt of options) {
        probabilities[opt] = clampProb(asNumber(rawProbs[opt]), 0);
      }
      const topChoice = options.includes(asString(ans.choice))
        ? asString(ans.choice)
        : options.slice().sort()[0] || "";
      const confidence = clampProb(asNumber(ans.confidence) || probabilities[topChoice] || 0.5);
      result[key] = { type: "choice", choice: topChoice, confidence, probabilities };
    } else {
      const legend: Record<string, string> = {};
      const probabilities: Record<string, number> = {};
      const rawProbs = asJsonObject(ans.probabilities);
      question.criteria.forEach((desc, idx) => {
        const k = String(idx);
        legend[k] = desc;
        probabilities[k] = clampProb(asNumber(rawProbs[k]), 0);
      });
      const maxLevel = Math.max(1, question.criteria.length - 1);
      const rawScore = Number(ans.score);
      const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(maxLevel, rawScore)) : 0;
      const confidence = clampProb(asNumber(ans.confidence) || Math.max(...Object.values(probabilities), 0.5));
      result[key] = { type: "score", score, confidence, probabilities, legend };
    }
  }
  return result;
}

interface FallbackRoute {
  gateway: boolean;
  base: string;
  key: string;
  usedFallbackKey: boolean;
}

function listGenerativeRoutes(primaryKey: string, fallbackKey: string): FallbackRoute[] {
  const routes: FallbackRoute[] = [];
  const endpoint = process.env.LITELLM_ENDPOINT?.trim();
  const gatewayKey = process.env.LITELLM_API_KEY?.trim();
  if (endpoint && gatewayKey) {
    const clean = endpoint.replace(/\/+$/, "");
    routes.push({
      gateway: true,
      base: clean.endsWith("/v1") ? clean : `${clean}/v1`,
      key: gatewayKey,
      usedFallbackKey: false,
    });
  }
  if (primaryKey) {
    routes.push({ gateway: false, base: GEMINI_V1BETA_BASE, key: primaryKey, usedFallbackKey: false });
  }
  if (fallbackKey && fallbackKey !== primaryKey) {
    routes.push({ gateway: false, base: GEMINI_V1BETA_BASE, key: fallbackKey, usedFallbackKey: true });
  }
  return routes;
}

function resolveStructuredFallbackRoute(primaryKey: string, fallbackKey: string): FallbackRoute | null {
  const routes = listGenerativeRoutes(primaryKey, fallbackKey);
  return routes[0] || null;
}

async function callStructuredDecisionFallback(args: {
  route: FallbackRoute;
  input: string | readonly DecisionInputBlock[];
  questions: Readonly<Record<string, DecisionQuestion>>;
  timeoutMs: number;
  signal?: AbortSignal;
  customFetch: typeof fetch;
}): Promise<{ answers: Record<string, DecisionAnswer>; modelUsed: string; inputTokens: number }> {
  const schemaProperties: Record<string, JsonObject> = {};
  const requiredKeys = Object.keys(args.questions);
  const rubricLines: string[] = [];

  for (const [key, q] of Object.entries(args.questions)) {
    if (q.type === "noul") {
      schemaProperties[key] = {
        type: "object",
        required: ["noul", "confidence"],
        properties: {
          noul: { type: "number", minimum: 0, maximum: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      };
      rubricLines.push(`- ${key} (noul 0.01..0.99): ${q.instructions}`);
    } else if (q.type === "choice") {
      const choices = Object.keys((q as DecisionChoiceQuestion).criteria);
      schemaProperties[key] = {
        type: "object",
        required: ["choice", "confidence"],
        properties: {
          choice: { type: "string", enum: choices },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      };
      rubricLines.push(`- ${key} (choice ${JSON.stringify(choices)}): ${q.instructions} | Criteria: ${JSON.stringify(q.criteria)}`);
    } else {
      const maxIdx = Math.max(1, (q as DecisionScoreQuestion).criteria.length - 1);
      schemaProperties[key] = {
        type: "object",
        required: ["score", "confidence"],
        properties: {
          score: { type: "number", minimum: 0, maximum: maxIdx },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      };
      rubricLines.push(`- ${key} (score 0..${maxIdx}): ${q.instructions} | Levels: ${JSON.stringify(q.criteria)}`);
    }
  }

  const schema: JsonObject = normalizeOutputSchema({
    type: "object",
    required: requiredKeys,
    properties: schemaProperties,
    additionalProperties: false,
  });

  const textBlocks: string[] = [];
  const images: Array<{ data: string; mime: string }> = [];
  if (typeof args.input === "string") {
    textBlocks.push(args.input);
  } else {
    for (const block of args.input) {
      if (block.type === "text") textBlocks.push(block.text);
      else if (block.type === "image") images.push({ data: block.data, mime: block.mime_type });
    }
  }

  const prompt = [
    "Act as a deterministic zero-temperature calibrated probability classifier.",
    "Evaluate every question independently against the shared input and return ONLY valid JSON.",
    "INPUT:",
    textBlocks.join("\n"),
    "QUESTIONS:",
    rubricLines.join("\n"),
  ].join("\n");

  const requestedFallbackModel = resolveGenerativeModelName(config.geminiStylistModel || config.geminiModel || "gemini-3.5-flash");
  const modelCandidates = args.route.gateway
    ? [requestedFallbackModel]
    : resolveGenerativeModelCandidates(requestedFallbackModel);

  let lastModelError: unknown = null;
  for (const fallbackModel of modelCandidates) {
    try {
      const url = args.route.gateway
        ? `${args.route.base}/chat/completions`
        : `${GEMINI_V1BETA_BASE}/models/${encodeURIComponent(fallbackModel)}:generateContent`;

      const body = args.route.gateway
        ? {
            model: fallbackModel,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: `Return strictly JSON matching schema: ${JSON.stringify(schema)}` },
              {
                role: "user",
                content: images.length
                  ? [
                      { type: "text", text: prompt },
                      ...images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } })),
                    ]
                  : prompt,
              },
            ],
          }
        : {
            contents: [
              {
                role: "user",
                parts: [
                  { text: prompt },
                  ...images.map((img) => ({ inlineData: { mimeType: img.mime, data: img.data } })),
                ],
              },
            ],
            generationConfig: {
              temperature: 0,
              responseMimeType: "application/json",
              responseSchema: stripUnsupportedGeminiSchemaKeys(schema),
            },
          };

      const response = await args.customFetch(url, {
        method: "POST",
        redirect: "error",
        signal: args.signal ?? AbortSignal.timeout(args.timeoutMs),
        headers: {
          "content-type": "application/json",
          ...(args.route.gateway ? { authorization: `Bearer ${args.route.key}` } : { "x-goog-api-key": args.route.key }),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const mapped = mapStatusToHttpError(response.status);
        if (mapped.code === "AI_PROVIDER_UNAUTHORIZED" || mapped.code === "AI_PROVIDER_REJECTED") {
          throw mapped; // Invalid key for this route; bubble up immediately to next route
        }
        lastModelError = mapped;
        continue;
      }

      const payload = asJsonObject(await response.json());
      const rawText = extractGeneratedText(payload, args.route.gateway);
      const decoded = asJsonObject(JSON.parse(rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()));
      validateOutput(decoded, schema);

      const normalizedRaw: JsonObject = {};
      for (const [key, q] of Object.entries(args.questions)) {
        const item = asJsonObject(decoded[key]);
        if (q.type === "noul") {
          const noul = clampProb(asNumber(item.noul));
          normalizedRaw[key] = { type: "noul", noul, confidence: clampProb(asNumber(item.confidence) || Math.max(noul, 1 - noul)) };
        } else if (q.type === "choice") {
          const opts = Object.keys(q.criteria);
          const choice = asString(item.choice);
          const conf = clampProb(asNumber(item.confidence) || 0.85);
          const rem = opts.length > 1 ? (1 - conf) / (opts.length - 1) : 0;
          const probabilities = Object.fromEntries(opts.map((o) => [o, o === choice ? conf : rem]));
          normalizedRaw[key] = { type: "choice", choice, confidence: conf, probabilities };
        } else {
          const score = asNumber(item.score);
          const conf = clampProb(asNumber(item.confidence) || 0.85);
          const nearest = String(Math.round(score));
          const probabilities = Object.fromEntries(q.criteria.map((_, idx) => [String(idx), String(idx) === nearest ? conf : (1 - conf) / Math.max(1, q.criteria.length - 1)]));
          normalizedRaw[key] = { type: "score", score, confidence: conf, probabilities };
        }
      }

      const usage = asJsonObject(payload.usage || payload.usageMetadata);
      const inputTokens = Math.max(0, Math.round(asNumber(usage.prompt_tokens ?? usage.promptTokenCount) || 0));
      return {
        answers: parseAndValidateDecisionAnswers(args.questions, normalizedRaw),
        modelUsed: fallbackModel,
        inputTokens,
      };
    } catch (err: unknown) {
      lastModelError = err;
      if (isAbortError(err, args.signal)) throw err;
      if (err instanceof HttpError && (err.code === "AI_PROVIDER_UNAUTHORIZED" || err.code === "AI_PROVIDER_REJECTED")) {
        throw err;
      }
    }
  }
  if (lastModelError instanceof HttpError) throw lastModelError;
  throw new HttpError(502, "AI_PROVIDER_UNAVAILABLE", "Dịch vụ AI tạm thời gián đoạn.");
}

function validateDecisionRequest(request: CreateDecisionRequest): void {
  const keys = Object.keys(request.questions);
  if (!keys.length || keys.length > 1000) {
    throw new HttpError(400, "AI_DECISION_QUESTIONS_INVALID", "Số lượng câu hỏi Decision phải từ 1 đến 1000.");
  }
  for (const [key, q] of Object.entries(request.questions)) {
    if (!QUESTION_KEY_PATTERN.test(key) || !q.instructions.trim()) {
      throw new HttpError(400, "AI_DECISION_QUESTION_KEY_INVALID", `Khóa hoặc hướng dẫn câu hỏi '${key}' không hợp lệ.`);
    }
    if (q.type === "choice") {
      const optKeys = Object.keys(q.criteria);
      if (optKeys.length < 2 || optKeys.length > 255) {
        throw new HttpError(400, "AI_DECISION_CHOICE_INVALID", `Câu hỏi '${key}' cần từ 2 đến 255 lựa chọn.`);
      }
    } else if (q.type === "score") {
      if (q.criteria.length < 2 || q.criteria.length > 255 || q.criteria.some((c) => !c.trim())) {
        throw new HttpError(400, "AI_DECISION_SCORE_INVALID", `Thang điểm '${key}' cần từ 2 đến 255 mức hợp lệ.`);
      }
    }
  }
}

function resolveGenerativeModelName(rawModel: string): string {
  const trimmed = rawModel.trim();
  if (!trimmed || trimmed === "gemini-1.5-flash" || trimmed === "gemini-2.5-flash") return "gemini-3.5-flash";
  return trimmed;
}

function resolveGenerativeModelCandidates(requestedModel: string): string[] {
  return Array.from(
    new Set([
      requestedModel,
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite",
      "gemini-3.8-flash",
      "gemini-flash-lite-latest",
    ]),
  );
}

function stripUnsupportedGeminiSchemaKeys(schema: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties" || k === "$schema") continue;
    if (k === "properties" && isJsonObject(v)) {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([pk, pv]) => [pk, isJsonObject(pv) ? stripUnsupportedGeminiSchemaKeys(pv) : pv]),
      );
    } else if (k === "items" && isJsonObject(v)) {
      out.items = stripUnsupportedGeminiSchemaKeys(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function extractGeneratedText(payload: JsonObject, gateway: boolean): string {
  if (gateway) {
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const msg = asJsonObject(asJsonObject(choices[0]).message);
    const content = asString(msg.content).trim();
    if (!content) throw new HttpError(502, "AI_TEXT_EMPTY", "AI trả về nội dung rỗng.");
    return content;
  }
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const parts = asJsonObject(asJsonObject(candidates[0]).content).parts;
  const text = (Array.isArray(parts) ? parts : [])
    .filter((p) => isJsonObject(p) && p.thought !== true)
    .map((p) => asString(asJsonObject(p).text))
    .join("")
    .trim();
  if (!text) throw new HttpError(502, "AI_TEXT_EMPTY", "AI trả về nội dung rỗng.");
  return text;
}

function mapStatusToHttpError(status: number): HttpError {
  if (status === 429) return new HttpError(429, "AI_PROVIDER_RATE_LIMITED", "Đã chạm giới hạn hạn ngạch AI.");
  if (status === 401 || status === 403) return new HttpError(503, "AI_PROVIDER_UNAUTHORIZED", "Xác thực khóa AI thất bại.");
  if (status === 404 || status === 405 || status === 501) return new HttpError(503, "AI_PROVIDER_UNSUPPORTED", "Model AI không hỗ trợ phương thức này.");
  if (status >= 400 && status < 500) return new HttpError(502, "AI_PROVIDER_REJECTED", "Yêu cầu tới AI bị từ chối.");
  return new HttpError(502, "AI_PROVIDER_UNAVAILABLE", "Dịch vụ AI tạm thời gián đoạn.");
}

function shouldTripCircuit(err: unknown): boolean {
  if (!(err instanceof HttpError)) return true;
  return [429, 500, 502, 503, 504].includes(err.status);
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (err instanceof HttpError && err.code === "AI_CANCELLED");
}

function clampProb(value: number, min = 0.01): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(0.9999, value));
}

function getOrCreateMetric(useCase: DecisionUseCase): DecisionEngineMetric {
  let metric = decisionMetrics.get(useCase);
  if (!metric) {
    metric = {
      useCase,
      requests: 0,
      failures: 0,
      fallbackKeyCount: 0,
      structuredFallbackCount: 0,
      humanReviewCount: 0,
      latencyMs: 0,
      inputTokens: 0,
    };
    decisionMetrics.set(useCase, metric);
  }
  return metric;
}
