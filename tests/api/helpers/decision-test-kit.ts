/**
 * Shared Deterministic Test Kit for Modular AI UAT (`F1`–`F7`) & In-Memory Mutation Testing.
 *
 * Uses cached compact 160x160 Sharp raster buffers so all 7 spec suites execute in < 3s with zero external network calls.
 */

import sharp from "sharp";
import type {
  CreateDecisionRequest,
  CreateDecisionResult,
  DecisionAnswer,
  DecisionChoiceAnswer,
  DecisionNoulAnswer,
  DecisionScoreAnswer,
} from "../../../apps/api/src/decision/decision-types.js";

const imageCache = new Map<string, Promise<Buffer>>();

export interface SyntheticImageSpec {
  readonly width?: number;
  readonly height?: number;
  readonly bg: readonly [number, number, number];
  readonly subject: readonly [number, number, number];
  readonly sclera?: readonly [number, number, number];
  readonly crispGrid?: boolean;
  readonly solidOnly?: boolean;
}

/** Generates and caches a deterministic JPEG image buffer for fast offline vision tests. */
export function getCachedSyntheticImage(key: string, spec: SyntheticImageSpec): Promise<Buffer> {
  const hit = imageCache.get(key);
  if (hit) return hit;
  const created = (async () => {
    const width = spec.width ?? 160;
    const height = spec.height ?? 160;
    const raw = Buffer.alloc(width * height * 3);
    const [bgR, bgG, bgB] = spec.bg;
    const [subR, subG, subB] = spec.subject;
    const sclera = spec.sclera ?? [244, 244, 245];

    for (let y = 0; y < height; y += 1) {
      const ny = y / height;
      for (let x = 0; x < width; x += 1) {
        const nx = x / width;
        const idx = (y * width + x) * 3;
        if (spec.solidOnly) {
          raw[idx] = bgR;
          raw[idx + 1] = bgG;
          raw[idx + 2] = bgB;
          continue;
        }
        const inSclera = ny >= 0.28 && ny <= 0.36 && nx >= 0.34 && nx <= 0.66;
        const inSubject = ny > 0.36 && ny <= 0.76 && nx >= 0.26 && nx <= 0.74;
        if (inSclera) {
          raw[idx] = sclera[0];
          raw[idx + 1] = sclera[1];
          raw[idx + 2] = sclera[2];
        } else if (inSubject) {
          const tex = spec.crispGrid && (x + y) % 4 === 0 ? 18 : 0;
          raw[idx] = Math.max(0, Math.min(255, subR - tex));
          raw[idx + 1] = Math.max(0, Math.min(255, subG - tex));
          raw[idx + 2] = Math.max(0, Math.min(255, subB - tex));
        } else {
          raw[idx] = bgR;
          raw[idx + 1] = bgG;
          raw[idx + 2] = bgB;
        }
      }
    }
    return sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 92 })
      .toBuffer();
  })();
  imageCache.set(key, created);
  return created;
}

/** Builds a calibrated `noul` binary probability answer. */
export function noul(prob: number, confidence = Math.max(prob, 1 - prob)): DecisionNoulAnswer {
  return { type: "noul", noul: prob, confidence };
}

/** Builds a calibrated `choice` categorical distribution answer. */
export function choice(selected: string, options: readonly string[], confidence = 0.91): DecisionChoiceAnswer {
  const rem = options.length > 1 ? (1 - confidence) / (options.length - 1) : 0;
  return {
    type: "choice",
    choice: selected,
    confidence,
    probabilities: Object.fromEntries(options.map((o) => [o, o === selected ? confidence : rem])),
  };
}

/** Builds a calibrated `score` expectation answer on `0..levels-1`. */
export function score(val: number, levels = 5, confidence = 0.90): DecisionScoreAnswer {
  const nearest = String(Math.max(0, Math.min(levels - 1, Math.round(val))));
  const rem = levels > 1 ? (1 - confidence) / (levels - 1) : 0;
  return {
    type: "score",
    score: val,
    confidence,
    probabilities: Object.fromEntries(
      Array.from({ length: levels }, (_, i) => [String(i), String(i) === nearest ? confidence : rem]),
    ),
    legend: Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), `Level ${i}`])),
  };
}

/** Wraps an `answers` map into a complete `CreateDecisionResult` fixture. */
export function mockDecisionResult(
  answers: Record<string, DecisionAnswer>,
  overrides: Partial<CreateDecisionResult> = {},
): CreateDecisionResult {
  return {
    answers,
    modelUsed: "gemini-decision-1",
    transport: "decisions_api",
    usedFallbackKey: false,
    rolloutMode: "active",
    latencyMs: 12,
    inputTokens: 128,
    ...overrides,
  };
}

/** Temporarily scrubs AI/Supabase env variables during a test callback and restores them cleanly in `finally`. */
export async function withScrubbedAiEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const keys = [
    "NODE_ENV",
    "GEMINI_PRIMARY_KEY",
    "GEMINI_API_KEY",
    "GEMINI_FALLBACK_FREE_KEY",
    "GEMINI_DECISION_FALLBACK_KEY",
    "LOCAL_GEMINI_ENV_PATH",
    "ALLOW_LOCAL_GEMINI_ENV_FALLBACK",
    "LITELLM_ENDPOINT",
    "LITELLM_API_KEY",
    "AI_DECISION_ROLLOUT_MODE",
    "AI_DECISION_CANARY_PERCENT",
    ...Object.keys(overrides),
  ];
  const saved = new Map<string, string | undefined>();
  for (const k of keys) {
    saved.set(k, process.env[k]);
  }
  try {
    process.env.GEMINI_PRIMARY_KEY = "";
    process.env.GEMINI_API_KEY = "";
    process.env.GEMINI_FALLBACK_FREE_KEY = "";
    process.env.GEMINI_DECISION_FALLBACK_KEY = "";
    process.env.LOCAL_GEMINI_ENV_PATH = "";
    process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK = "false";
    process.env.LITELLM_ENDPOINT = "";
    process.env.LITELLM_API_KEY = "";
    process.env.AI_DECISION_ROLLOUT_MODE = "active";
    process.env.AI_DECISION_CANARY_PERCENT = "100";
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of saved.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export type MockEvaluatorBuilder = (req: CreateDecisionRequest) => Promise<CreateDecisionResult>;
