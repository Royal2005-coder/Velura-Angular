import { asJsonObject } from "../types.js";
import { HttpError } from "../http.js";
import type { PersonalColorPolicy, ColorResult, ConfirmedColor } from "./personal-color-types.js";

/** Four-season taxonomy is approved; calibrated thresholds, model, palette and retention still require versioned policy approval. */
export function loadPersonalColorPolicy(raw = process.env.PERSONAL_COLOR_POLICY): PersonalColorPolicy | null {
  try {
    const value = asJsonObject(JSON.parse(raw || "null"));
    const policy = value as unknown as PersonalColorPolicy;
    const taxonomy = asJsonObject(value.taxonomy), palette = asJsonObject(value.palette);
    const subtypeCount = Object.values(taxonomy).reduce<number>((count, rows) => count + (Array.isArray(rows) ? rows.length : 0), 0);
    if (policy.approved !== true || !/^[a-zA-Z0-9_.-]{1,64}$/.test(policy.version) || typeof policy.model !== "string" || !policy.model.trim() ||
      typeof policy.approvalReference !== "string" || !policy.approvalReference.trim() || typeof policy.calibrationReference !== "string" || !policy.calibrationReference.trim() ||
      Object.keys(taxonomy).length !== 4 || subtypeCount !== 4 ||
      ["Spring", "Summer", "Autumn", "Winter"].some((season) => !Array.isArray(taxonomy[season]) || (taxonomy[season] as unknown[]).length !== 1 || (taxonomy[season] as unknown[])[0] !== season) ||
      !Object.keys(palette).length || Object.values(palette).some((color) => typeof color !== "string" || !/^#[a-f0-9]{6}$/i.test(color)) ||
      !Number.isFinite(policy.minConfidence) || policy.minConfidence <= 0 || policy.minConfidence > 1 ||
      [policy.maxBytes, policy.minWidth, policy.minHeight, policy.maxPixels, policy.retentionSeconds, policy.timeoutMs].some((n) => !Number.isSafeInteger(n) || n <= 0) ||
      policy.maxBytes > 8 * 1024 * 1024 || policy.retentionSeconds > 3600 || policy.timeoutMs > 300000 ||
      Object.keys(palette).some((key) => !Array.isArray(policy.productColorMapping?.[key]) || !policy.productColorMapping[key].length) ||
      Object.entries(asJsonObject(value.productColorMapping)).some(([key, rows]) => !palette[key] || !Array.isArray(rows) || rows.some((item) => typeof item !== "string" || !item))) return null;
    return policy;
  } catch { return null; }
}

/** Reject malformed, hallucinated or contradictory model output rather than coercing it. */
export function validateColorResult(raw: unknown, policy: PersonalColorPolicy): ColorResult {
  const value = asJsonObject(raw);
  const keys = Object.keys(value);
  const colors = (rows: unknown): rows is string[] => Array.isArray(rows) && rows.length > 0 && rows.length <= Object.keys(policy.palette).length && rows.every((item) => typeof item === "string" && Object.hasOwn(policy.palette, item)) && new Set(rows).size === rows.length;
  if (keys.length !== 5 || !["season", "subtype", "palette", "avoided", "confidence"].every((key) => keys.includes(key)) ||
    typeof value.season !== "string" || typeof value.subtype !== "string" || !policy.taxonomy[value.season]?.includes(value.subtype) ||
    !colors(value.palette) || !colors(value.avoided) || value.palette.some((item) => (value.avoided as string[]).includes(item)) ||
    typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    throw new HttpError(502, "COLOR_OUTPUT_INVALID", "Kết quả phân tích màu chưa hợp lệ.");
  }
  return { season: value.season, subtype: value.subtype, palette: value.palette, avoided: value.avoided, confidence: value.confidence, policy_version: policy.version };
}

/** Read confirmed data only; analysis previews and legacy arbitrary fields never personalize recommendations. */
export function confirmedPersonalColor(profile: unknown, policy: PersonalColorPolicy | null): ConfirmedColor | null {
  const value = asJsonObject(asJsonObject(profile).personal_color);
  if (!policy || value.status !== "CONFIRMED" || value.policy_version !== policy.version || typeof value.analysis_id !== "string" || typeof value.confirmed_at !== "string" || !Number.isFinite(Date.parse(value.confirmed_at))) return null;
  try {
    const result = validateColorResult({ season: value.season, subtype: value.subtype, palette: value.palette, avoided: value.avoided, confidence: value.confidence }, policy);
    if (result.confidence < policy.minConfidence) return null;
    return { ...result, status: "CONFIRMED", analysis_id: value.analysis_id, confirmed_at: value.confirmed_at };
  } catch { return null; }
}

/** Color adds a bounded preference to existing body/style/occasion/budget scoring; it never replaces those signals. */
export function personalColorProductScore(profile: unknown, productColors: unknown, policy: PersonalColorPolicy | null): number {
  const color = confirmedPersonalColor(profile, policy);
  if (!color || !policy) return 0;
  const rows = Array.isArray(productColors) ? productColors : [productColors];
  const product = new Set(rows.filter((value): value is string => typeof value === "string").map((value) => value.toLocaleLowerCase()));
  const matches = (colors: string[]) => colors.some((id) => (policy.productColorMapping[id] || []).some((name) => product.has(name.toLocaleLowerCase())));
  return matches(color.avoided) ? -1 : matches(color.palette) ? 1 : 0;
}
