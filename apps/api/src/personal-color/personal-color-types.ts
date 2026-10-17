import type { AuthContext } from "../types.js";

/** Business-approved taxonomy and image handling; missing approval disables inference. */
export interface PersonalColorPolicy {
  version: string;
  approved: boolean;
  approvalReference: string;
  calibrationReference: string;
  model: string;
  taxonomy: Record<string, string[]>;
  palette: Record<string, string>;
  minConfidence: number;
  maxBytes: number;
  minWidth: number;
  minHeight: number;
  maxPixels: number;
  retentionSeconds: number;
  timeoutMs: number;
  productColorMapping: Record<string, string[]>;
}
/** Principal comes from verified auth or the existing high-entropy guest session, never request JSON. */
export interface ColorPrincipal { owner: string; userId?: string; guestId?: string; context?: AuthContext; }
/** Validated inference is only a preview until atomic user confirmation. */
export interface ColorResult {
  season: string;
  subtype: string;
  palette: string[];
  avoided: string[];
  confidence: number;
  policy_version: string;
}
/** The only color value allowed into recommendation or stylist context. */
export interface ConfirmedColor extends ColorResult { status: "CONFIRMED"; analysis_id: string; confirmed_at: string; }
/** Analysis metadata excludes input paths, image bytes and owner identity from public responses. */
export interface ColorAnalysis {
  id: string;
  status: "RUNNING" | "SUCCESS" | "LOW_CONFIDENCE" | "VALIDATION_FAILED" | "FAILED" | "TIMEOUT" | "CANCELLED" | "CONFIRMED";
  profile_version: number;
  policy_version: string;
  expires_at: string;
  result?: ColorResult;
  error?: string;
}
/** Member storage is durable; guest storage shares the existing session Style Profile. */
export interface ColorRepository {
  profile(principal: ColorPrincipal): Promise<{ version: number; personal_color: ConfirmedColor | null }>;
  begin(principal: ColorPrincipal, analysis: ColorAnalysis): Promise<ColorAnalysis>;
  get(principal: ColorPrincipal, id: string): Promise<ColorAnalysis>;
  finish(principal: ColorPrincipal, id: string, patch: Pick<ColorAnalysis, "status" | "result" | "error">): Promise<ColorAnalysis>;
  confirm(principal: ColorPrincipal, id: string, version: number): Promise<{ version: number; personal_color: ConfirmedColor }>;
  confirmManual(principal: ColorPrincipal, personalColor: ConfirmedColor, version: number): Promise<{ version: number; personal_color: ConfirmedColor }>;
}
/** Adapter must read and delete only owner-authorized private AI assets. */
export interface ColorAssets {
  readOwnedAsset(owner: string, id: string): Promise<{ bytes: Buffer; mime: string; expires_at: string }>;
  deleteOwnedAsset(owner: string, id: string): Promise<void>;
}
/** Real configured gateway vision, not a heuristic classifier. Backend validates every response. */
export interface ColorVision {
  ready(): boolean;
  generate(prompt: string, image: { bytes: Buffer; mime: string }, schema: unknown, options: { model: string; signal: AbortSignal }): Promise<unknown>;
}
