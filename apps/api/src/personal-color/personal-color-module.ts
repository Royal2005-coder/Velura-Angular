import { generateGeminiVisionJson, isGeminiConfigured } from "../gemini-client.js";
import { isDecisionEngineConfigured } from "../decision/gemini-decision-client.js";
import { unifiedDecisionService } from "../decision/decision-service.js";
import { loadPersonalColorPolicy } from "./personal-color-policy.js";
import { PersonalColorRepository } from "./personal-color-repository.js";
import { PersonalColorService } from "./personal-color-service.js";
import type { ColorAssets } from "./personal-color-types.js";

/** Wire real configured `gemini-decision-1` + vision fallback and private owner-bound AI storage; policy absence disables capability. */
export function createPersonalColorService(assets: ColorAssets): PersonalColorService {
  const policy = loadPersonalColorPolicy();
  return new PersonalColorService(new PersonalColorRepository(policy), assets, {
    ready: () => isGeminiConfigured() || isDecisionEngineConfigured(),
    generate: (prompt, image, schema, options) => generateGeminiVisionJson(prompt, image.bytes, image.mime, schema, { ...options, timeoutMs: policy?.timeoutMs, maxRetries: 2 }),
    decide: (image, options) => unifiedDecisionService.decidePersonalColor(image, { policy, entityId: options.entityId, actorId: options.actorId, signal: options.signal }),
  }, policy);
}
