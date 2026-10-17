import type { JsonObject } from "../types.js";

/** Server-resolved owner; member sessions never keep a guest identity. */
export interface ChatActor {
  authUserId: string;
  profileUserId: string;
  guestId: string | null;
}

/** Official source snapshot; approved policy sources alone authorize L2 advice. */
export interface ChatSource {
  id: string;
  kind: "policy" | "product" | "order" | "page" | "promotion";
  recordId: string;
  version: string;
  content: string;
  approved: boolean;
  snapshot: JsonObject;
}

/** Content-free provider measurements; model is null when the provider supplies no identity. */
export interface ChatModelTrace {
  operation: "analysis" | "filter_review" | "draft" | "response_review";
  provider: "mistral" | "gemini";
  transport: "gateway" | "direct";
  requestedModel: string;
  model: string | null;
  latencyMs: number;
  outcome: "ok" | "rejected" | "unavailable" | "invalid";
  streamed: boolean;
}

/** Parsed model classification; issueKey correlates the same unresolved problem across paraphrases, and risk never changes account access. */
export interface ChatAnalysis {
  intent: "facts" | "catalog" | "policy_problem" | "order" | "human";
  level: "L0" | "L1" | "L2" | "L3";
  issue: "general" | "catalog" | "sizing" | "delivery" | "return" | "payment" | "cancellation";
  context: { issueKey: string; problem: string; wanted: string; failedApproaches: string[]; compromiseFailed: boolean; authorityExceeded: boolean; repeatCount?: number; escalationTrend?: "stable" | "rising" | "falling"; rejectedApproach?: boolean };
  sentiment: "positive" | "neutral" | "negative";
  risk: "green" | "yellow" | "orange" | "red";
  moderation: "none" | "abuse" | "threat" | "illegal" | "sensitive";
  /** Staff-safe transcript preserving legitimate requests with profanity replaced by *** and identifiers removed. */
  filtered: { text: string; problem: string; wanted: string; failedApproaches: string[] };
  confidence: number;
  reasons: string[];
  /** Emotion and content risk are independent; anger alone is not abuse. */
  emotion?: { state: "calm" | "frustrated" | "angry" | "distressed"; confidence: number; reasons: string[] };
  riskAssessment?: { confidence: number; reasons: string[] };
  trace?: ChatModelTrace[];
}

/** Every factual claim cites a verbatim passage from an official source. */
export interface ChatDraft {
  text: string;
  productIds: string[];
  claims: { sourceId: string; quote: string }[];
  approach: string;
  promisedActions: string[];
  trace?: ChatModelTrace[];
}

/** Fail-closed response review result; rejected drafts are never message rows. */
export interface ChatRiskResult {
  safe: boolean;
  reasons: string[];
  trace?: ChatModelTrace[];
}

/** Provider calls are injectable for behavior tests, never replaced in production. */
export interface ChatModel {
  analyze(message: string, history: JsonObject[]): Promise<ChatAnalysis>;
  draft(message: string, history: JsonObject[], analysis: ChatAnalysis, sources: ChatSource[]): Promise<ChatDraft>;
  review(message: string, analysis: ChatAnalysis, draft: ChatDraft, sources: ChatSource[]): Promise<ChatRiskResult>;
}
