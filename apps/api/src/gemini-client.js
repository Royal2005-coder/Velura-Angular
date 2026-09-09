import { config } from "./config.js";
import { HttpError } from "./http.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

export function isGeminiConfigured() {
  return Boolean(config.geminiApiKey);
}

export async function generateGeminiEmbedding(text, options = {}) {
  requireGeminiKey();
  const model = options.model || config.geminiEmbeddingModel;
  const dimensions = Number(options.dimensions || config.geminiEmbeddingDimensions || 1536);
  const payload = {
    content: {
      parts: [{ text: String(text || "").slice(0, 12000) }]
    },
    output_dimensionality: dimensions
  };

  const data = await geminiRequestWithRetry(`/models/${encodeURIComponent(model)}:embedContent`, payload);
  const values = data?.embedding?.values || data?.embeddings?.[0]?.values;
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

export async function generateGeminiJson(prompt, schema, options = {}) {
  requireGeminiKey();
  const model = options.model || config.geminiStylistModel;
  const payload = {
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
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) {
    console.error("[GEMINI_JSON_EMPTY] Raw response:", JSON.stringify(data).slice(0, 500));
    throw new HttpError(502, "GEMINI_JSON_EMPTY", "Gemini returned an empty stylist response");
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    console.error("[GEMINI_JSON_INVALID] Response text:", text.slice(0, 300));
    throw new HttpError(502, "GEMINI_JSON_INVALID", "Gemini stylist response is not valid JSON", {
      parserMessage: error.message,
      responsePreview: text.slice(0, 200)
    });
  }
}

export async function generateGeminiText(prompt, options = {}) {
  requireGeminiKey();
  const model = options.model || config.geminiModel || config.geminiStylistModel;
  const payload = {
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
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((part) => part.text || "").join("").trim();
  if (!text) {
    throw new HttpError(502, "GEMINI_TEXT_EMPTY", "Gemini returned an empty response");
  }
  return text;
}

export function vectorLiteral(values) {
  if (!Array.isArray(values) || !values.length) {
    throw new HttpError(500, "INVALID_VECTOR", "Embedding vector is empty");
  }
  return `[${values.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

async function geminiRequestWithRetry(path, payload, options = {}) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await geminiRequest(path, payload, options);
    } catch (error) {
      lastError = error;
      const isRetryable = error instanceof HttpError && [429, 500, 502, 503].includes(error.status);
      if (!isRetryable || attempt === MAX_RETRIES) {
        throw error;
      }
      console.warn(`[GEMINI RETRY] Attempt ${attempt + 1}/${MAX_RETRIES} failed (${error.status}), retrying in ${RETRY_DELAY_MS}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastError;
}

async function geminiRequest(path, payload, options = {}) {
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
    const geminiMessage = data?.error?.message || response.statusText;
    console.error(`[GEMINI API ERROR] ${response.status} on ${path}:`, geminiMessage);
    throw new HttpError(response.status, "GEMINI_API_ERROR", `Gemini API error: ${geminiMessage}`, {
      status: response.status,
      message: geminiMessage,
      path
    });
  }

  // Check for safety blocks in promptFeedback
  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) {
    console.error(`[GEMINI SAFETY BLOCK] Reason: ${blockReason}`);
    throw new HttpError(400, "GEMINI_SAFETY_BLOCK", `Gemini blocked the request: ${blockReason}`);
  }

  // Check for empty candidates
  if (!data?.candidates?.length) {
    console.error("[GEMINI NO CANDIDATES] Raw response:", JSON.stringify(data).slice(0, 500));
  }

  return data;
}

export async function analyzeImageWithGemini(base64Data, mimeType, userPrompt) {
  requireGeminiKey();
  const model = "gemini-3.5-flash"; 
  const cleanBase64 = base64Data.replace(/^data:image\/[a-zA-Z+.-]+;base64,/, "");

  const payload = {
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
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return text;
}

function requireGeminiKey() {
  if (!config.geminiApiKey) {
    throw new HttpError(503, "GEMINI_API_KEY_REQUIRED", "Gemini API key is not configured. Set GEMINI_API_KEY in .env");
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
