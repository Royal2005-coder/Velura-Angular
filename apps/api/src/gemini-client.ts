import { config } from "./config.js";
import { HttpError } from "./http.js";
import { asJsonObject, asString, errorMessage, isJsonObject, type JsonObject } from "./types.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

/**
 * Optional overrides for `generateGeminiEmbedding`.
 */
export interface GeminiEmbeddingOptions {
  model?: string;
  dimensions?: number;
}

/**
 * Optional overrides for `generateGeminiJson`.
 */
export interface GeminiJsonOptions {
  model?: string;
}

/**
 * Optional overrides for `generateGeminiText`.
 */
export interface GeminiTextOptions {
  model?: string;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

interface GeminiRequestOptions {
  timeoutMs?: number;
}

/**
 * True when a Gemini API key is present in config.
 */
export function isGeminiConfigured(): boolean {
  return Boolean(config.geminiApiKey);
}

/**
 * Request a Gemini embedding vector for `text`.
 */
export async function generateGeminiEmbedding(
  text: unknown,
  options: GeminiEmbeddingOptions = {}
): Promise<number[]> {
  requireGeminiKey();
  const model = options.model || config.geminiEmbeddingModel;
  const dimensions = Number(options.dimensions || config.geminiEmbeddingDimensions || 1536);
  const payload: JsonObject = {
    content: {
      parts: [{ text: String(text || "").slice(0, 12000) }]
    },
    output_dimensionality: dimensions
  };

  const data = await geminiRequestWithRetry(`/models/${encodeURIComponent(model)}:embedContent`, payload);
  const values = readEmbeddingValues(data);
  if (!Array.isArray(values)) {
    throw new HttpError(502, "GEMINI_EMBEDDING_INVALID", "Gemini embedding response is invalid");
  }
  const slicedValues = values.slice(0, dimensions);
  if (slicedValues.length !== dimensions) {
    throw new HttpError(502, "GEMINI_EMBEDDING_INVALID", "Gemini embedding response is invalid", {
      expectedDimensions: dimensions,
      actualDimensions: slicedValues.length
    });
  }
  return slicedValues.map(Number);
}

/**
 * Request Gemini JSON that matches `schema` and parse the first candidate.
 */
export async function generateGeminiJson(
  prompt: unknown,
  schema: unknown,
  options: GeminiJsonOptions = {}
): Promise<unknown> {
  requireGeminiKey();
  const model = options.model || config.geminiStylistModel;
  const payload: JsonObject = {
    contents: [{
      parts: [{ text: String(prompt || "").slice(0, 30000) }]
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema
    }
  };

  const data = await geminiRequestWithRetry(`/models/${encodeURIComponent(model)}:generateContent`, payload);

  // Gemini response: candidates[0].content.parts[0].text
  const text = readFirstCandidateText(data);
  if (!text) {
    console.error("[GEMINI_JSON_EMPTY] Raw response:", JSON.stringify(data).slice(0, 500));
    throw new HttpError(502, "GEMINI_JSON_EMPTY", "Gemini returned an empty stylist response");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    console.error("[GEMINI_JSON_INVALID] Response text:", text.slice(0, 300));
    throw new HttpError(502, "GEMINI_JSON_INVALID", "Gemini stylist response is not valid JSON", {
      parserMessage: errorMessage(error),
      responsePreview: text.slice(0, 200)
    });
  }
}

/**
 * Request Gemini plain text from a single user prompt.
 */
export async function generateGeminiText(
  prompt: unknown,
  options: GeminiTextOptions = {}
): Promise<string> {
  requireGeminiKey();
  const model = options.model || config.geminiModel || config.geminiStylistModel;
  const payload: JsonObject = {
    contents: [
      {
        role: "user",
        parts: [{ text: String(prompt || "").slice(0, 30000) }]
      }
    ],
    generationConfig: {
      temperature: options.temperature ?? 0.35,
      topP: options.topP ?? 0.9,
      maxOutputTokens: options.maxOutputTokens ?? 1600
    }
  };

  const data = await geminiRequestWithRetry(
    `/models/${encodeURIComponent(model)}:generateContent`,
    payload,
    { timeoutMs: options.timeoutMs }
  );
  const parts = readCandidateParts(data);
  const text = parts.map((part) => asString(part.text)).join("").trim();
  if (!text) {
    throw new HttpError(502, "GEMINI_TEXT_EMPTY", "Gemini returned an empty response");
  }
  return text;
}

/**
 * Format an embedding array as a PostgREST vector literal.
 */
export function vectorLiteral(values: unknown): string {
  if (!Array.isArray(values) || !values.length) {
    throw new HttpError(500, "INVALID_VECTOR", "Embedding vector is empty");
  }
  return `[${values.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

async function geminiRequestWithRetry(
  path: string,
  payload: JsonObject,
  options: GeminiRequestOptions = {}
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await geminiRequest(path, payload, options);
    } catch (error: unknown) {
      lastError = error;
      const aborted = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      if (aborted) {
        throw new HttpError(504, "GEMINI_TIMEOUT", "Gemini quá thời gian phản hồi. Thử lại sau vài giây.");
      }
      if (!(error instanceof HttpError)) {
        throw new HttpError(502, "GEMINI_UNAVAILABLE", `Gemini không phản hồi: ${errorMessage(error)}`);
      }
      const isRetryable = [429, 500, 502, 503].includes(error.status);
      if (!isRetryable || attempt === MAX_RETRIES) {
        throw error;
      }
      const status = error instanceof HttpError ? error.status : "";
      console.warn(`[GEMINI RETRY] Attempt ${attempt + 1}/${MAX_RETRIES} failed (${status}), retrying in ${RETRY_DELAY_MS}ms...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastError;
}

async function geminiRequest(
  path: string,
  payload: JsonObject,
  options: GeminiRequestOptions = {}
): Promise<unknown> {
  const timeoutMs = Number(options.timeoutMs || config.requestTimeoutMs || 15000);
  const response = await fetch(`${GEMINI_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": config.geminiApiKey
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const text = await response.text();
  const data = text ? parseJson(text) : {};

  if (!response.ok) {
    const geminiMessage = readGeminiErrorMessage(data) || response.statusText;
    console.error(`[GEMINI API ERROR] ${response.status} on ${path}:`, geminiMessage);
    throw new HttpError(response.status, "GEMINI_API_ERROR", `Gemini API error: ${geminiMessage}`, {
      status: response.status,
      message: geminiMessage,
      path
    });
  }

  // Check for safety blocks in promptFeedback
  const blockReason = readBlockReason(data);
  if (blockReason) {
    console.error(`[GEMINI SAFETY BLOCK] Reason: ${blockReason}`);
    throw new HttpError(400, "GEMINI_SAFETY_BLOCK", `Gemini blocked the request: ${blockReason}`);
  }

  // Check for empty candidates
  if (!hasCandidates(data)) {
    console.error("[GEMINI NO CANDIDATES] Raw response:", JSON.stringify(data).slice(0, 500));
  }

  return data;
}

/**
 * Describe an image with Gemini Vision for chatbot attachments.
 */
export async function analyzeImageWithGemini(
  base64Data: string,
  mimeType: string,
  userPrompt: string
): Promise<string> {
  requireGeminiKey();
  const model = "gemini-3.5-flash";
  const cleanBase64 = base64Data.replace(/^data:image\/[a-zA-Z+.-]+;base64,/, "");

  const payload: JsonObject = {
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: mimeType || "image/jpeg",
              data: cleanBase64
            }
          },
          {
            text: userPrompt || "Hãy mô tả chi tiết hình ảnh này, đặc biệt là phom dáng, màu sắc, phong cách thời trang, và chất liệu nếu có."
          }
        ]
      }
    ]
  };

  const data = await geminiRequestWithRetry(`/models/${encodeURIComponent(model)}:generateContent`, payload);
  return readFirstCandidateText(data);
}

export interface GeneratedImage {
  mimeType: string;
  base64: string;
}

/**
 * Giữ đúng sản phẩm và thay nền bằng phông studio. Trả về ảnh do Gemini sinh, không phải bộ lọc sáng.
 */
export async function generateStudioProductImage(dataUrl: string, mimeType: string): Promise<GeneratedImage> {
  requireGeminiKey();
  const cleanBase64 = dataUrl.replace(/^data:image\/[a-zA-Z+.-]+;base64,/, "");
  const models = [
    process.env.GEMINI_IMAGE_MODEL || "",
    "gemini-2.5-flash-image",
    config.geminiModel || config.geminiStylistModel
  ].filter((model, index, all) => model && all.indexOf(model) === index);
  let lastError = "Gemini không trả về ảnh nền studio.";
  for (const model of models) {
    try {
      const data = await geminiRequestWithRetry(`/models/${encodeURIComponent(model)}:generateContent`, {
        contents: [{
          parts: [
            { inlineData: { mimeType: mimeType || "image/jpeg", data: cleanBase64 } },
            {
              text: "Edit the photo. Keep the foreground subject unchanged. Replace the background with a clean warm off-white studio backdrop and soft even light. Remove glare. Do not add text, logos, or props. Return the edited image."
            }
          ]
        }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"]
        }
      }, { timeoutMs: 45000 });
      const image = readGeneratedImage(data);
      if (image) return image;
      lastError = `${model} không kèm dữ liệu ảnh.`;
    } catch (error: unknown) {
      lastError = error instanceof HttpError ? error.message : errorMessage(error);
      console.warn(`[PRODUCT IMAGE] ${model}:`, lastError);
    }
  }
  throw new HttpError(502, "GEMINI_IMAGE_EMPTY", lastError);
}

function requireGeminiKey(): void {
  if (!config.geminiApiKey) {
    throw new HttpError(503, "GEMINI_API_KEY_REQUIRED", "Gemini API key is not configured. Set GEMINI_API_KEY in .env");
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function readEmbeddingValues(data: unknown): unknown[] | null {
  if (!isJsonObject(data)) return null;
  if (isJsonObject(data.embedding) && Array.isArray(data.embedding.values)) {
    return data.embedding.values;
  }
  if (Array.isArray(data.embeddings)) {
    const first = data.embeddings[0];
    if (isJsonObject(first) && Array.isArray(first.values)) {
      return first.values;
    }
  }
  return null;
}

function readGeneratedImage(data: unknown): GeneratedImage | null {
  for (const part of readCandidateParts(data)) {
    const inline = isJsonObject(part.inlineData) ? part.inlineData : isJsonObject(part.inline_data) ? part.inline_data : null;
    const base64 = inline ? asString(inline.data) : "";
    if (base64.length > 100) {
      return { mimeType: asString(inline?.mimeType || inline?.mime_type) || "image/png", base64 };
    }
  }
  return null;
}

function readCandidateParts(data: unknown): JsonObject[] {
  if (!isJsonObject(data) || !Array.isArray(data.candidates)) return [];
  const first = data.candidates[0];
  if (!isJsonObject(first) || !isJsonObject(first.content) || !Array.isArray(first.content.parts)) {
    return [];
  }
  return first.content.parts.map((part) => asJsonObject(part));
}

function readFirstCandidateText(data: unknown): string {
  const parts = readCandidateParts(data);
  return asString(parts[0]?.text);
}

function readGeminiErrorMessage(data: unknown): string {
  if (!isJsonObject(data) || !isJsonObject(data.error)) return "";
  return asString(data.error.message);
}

function readBlockReason(data: unknown): string {
  if (!isJsonObject(data) || !isJsonObject(data.promptFeedback)) return "";
  return asString(data.promptFeedback.blockReason);
}

function hasCandidates(data: unknown): boolean {
  return isJsonObject(data) && Array.isArray(data.candidates) && data.candidates.length > 0;
}
