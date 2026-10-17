import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { guestStyleProfiles } from "../../apps/api/src/user/quiz.js";
import { PersonalColorRepository } from "../../apps/api/src/personal-color/personal-color-repository.js";
import { PersonalColorService } from "../../apps/api/src/personal-color/personal-color-service.js";
import { confirmedPersonalColor, loadPersonalColorPolicy, personalColorProductScore, validateColorResult } from "../../apps/api/src/personal-color/personal-color-policy.js";
import { colorPrincipal } from "../../apps/api/src/personal-color/personal-color-router.js";
import type { AuthContext } from "../../apps/api/src/types.js";
import type { ColorAnalysis, ColorAssets, ColorPrincipal, ColorVision, PersonalColorPolicy } from "../../apps/api/src/personal-color/personal-color-types.js";

const policy: PersonalColorPolicy = { version: "test-4seasons-v1", approved: true, approvalReference: "test approval", calibrationReference: "test calibration", model: "test-vision", taxonomy: { Spring: ["Spring"], Summer: ["Summer"], Autumn: ["Autumn"], Winter: ["Winter"] }, palette: { peach: "#ffccaa", black: "#000000" }, minConfidence: 0.8, maxBytes: 1024 * 1024, minWidth: 10, minHeight: 10, maxPixels: 100000, retentionSeconds: 60, timeoutMs: 1000, productColorMapping: { peach: ["Peach"], black: ["Black"] } };
const output = { season: "Spring", subtype: "Spring", palette: ["peach"], avoided: ["black"], confidence: 0.9 };
const quality = { lighting_valid: true, skin_visible: true, blur_free: true, filter_free: true };

interface AnalysisCompletion { promise: Promise<ColorAnalysis>; resolve(value: ColorAnalysis): void; }
const completions = new Map<string, AnalysisCompletion>();
class ObservedRepository extends PersonalColorRepository {
  override async begin(principal: ColorPrincipal, analysis: ColorAnalysis): Promise<ColorAnalysis> {
    const value = await super.begin(principal, analysis);
    completions.set(value.id, Promise.withResolvers<ColorAnalysis>());
    return value;
  }
  override async finish(principal: ColorPrincipal, id: string, patch: Pick<ColorAnalysis, "status" | "result" | "error">): Promise<ColorAnalysis> {
    const value = await super.finish(principal, id, patch);
    if (value.status !== "RUNNING") completions.get(id)?.resolve(value);
    return value;
  }
}

async function fixture(vision?: ColorVision, overrides: Partial<PersonalColorPolicy> = {}) {
  const guestId = `gs_${randomUUID()}`;
  const principal: ColorPrincipal = { owner: `guest:${guestId}`, guestId };
  const configured = { ...policy, ...overrides };
  const repo = new ObservedRepository(configured);
  guestStyleProfiles.set(guestId, { body_shape: "Pear", style_tags: ["Casual"], budget_range: "300k_700k", style_profile_version: 0 });
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).png().toBuffer();
  let deleted = 0;
  const deletion = Promise.withResolvers<void>();
  const assets: ColorAssets = { readOwnedAsset: async (owner) => { assert.equal(owner, principal.owner); return { bytes, mime: "image/png", expires_at: new Date(Date.now() + 60000).toISOString() }; }, deleteOwnedAsset: async (owner) => { assert.equal(owner, principal.owner); deleted++; deletion.resolve(); } };
  let calls = 0;
  const defaultVision: ColorVision = { ready: () => true, generate: async () => ++calls === 1 ? quality : output };
  const service = new PersonalColorService(repo, assets, vision || defaultVision, configured);
  const begin = (version = 0) => service.analyze(principal, { asset_id: randomUUID(), expected_version: version, consent: true, policy_version: configured.version });
  return { principal, repo, service, begin, assets, bytes, deletion: deletion.promise, deleted: () => deleted };
}

async function terminal(service: PersonalColorService, principal: ColorPrincipal, id: string) {
  await completions.get(id)!.promise;
  return service.get(principal, id);
}

test("four-season taxonomy is strict; unapproved, missing calibration, 12-season and unmapped policies disable capability", () => {
  assert.equal(loadPersonalColorPolicy("null"), null);
  assert.deepEqual(loadPersonalColorPolicy(JSON.stringify(policy)), policy);
  for (const patch of [{ approved: false }, { calibrationReference: "" }, { productColorMapping: {} }, { minConfidence: NaN }, { taxonomy: { ...policy.taxonomy, Spring: ["Light", "Warm", "Bright"] } }]) assert.equal(loadPersonalColorPolicy(JSON.stringify({ ...policy, ...patch })), null);
  assert.deepEqual(validateColorResult(output, policy).policy_version, policy.version);
  for (const patch of [{ season: "Unknown" }, { subtype: "Winter" }, { palette: ["invented"] }, { confidence: "0.9" }, { confidence: Infinity }, { avoided: ["peach"] }, { extra: true }]) assert.throws(() => validateColorResult({ ...output, ...patch }, policy));
});

test("success preview is not persisted or read by recommendations; one concurrent confirmation wins", async () => {
  const f = await fixture();
  const created = await f.begin();
  const analysis = await terminal(f.service, f.principal, created.id);
  assert.equal(analysis.status, "SUCCESS");
  assert.equal((await f.service.profile(f.principal)).personal_color, null);
  assert.equal(confirmedPersonalColor({ personal_color: { ...analysis.result, status: "SUCCESS" } }, policy), null);
  assert.equal(personalColorProductScore({ personal_color: { ...analysis.result, status: "SUCCESS" } }, ["Peach"], policy), 0);
  const confirms = await Promise.allSettled([f.service.confirm(f.principal, analysis.id, 0), f.service.confirm(f.principal, analysis.id, 0)]);
  assert.equal(confirms.filter((item) => item.status === "fulfilled").length, 1);
  const profile = await f.service.profile(f.principal);
  assert.equal(profile.version, 1);
  assert.equal(profile.personal_color?.analysis_id, created.id);
  const stored = guestStyleProfiles.get(f.principal.guestId!);
  assert.equal(stored?.body_shape, "Pear");
  assert.equal(personalColorProductScore(stored, ["Peach"], policy), 1);
  assert.equal(personalColorProductScore(stored, ["Black"], policy), -1);
  await f.deletion;
  assert.equal(f.deleted(), 1);
});

test("low confidence stays a nonconfirmable preview and preserves previous confirmed result", async () => {
  let calls = 0;
  const f = await fixture({ ready: () => true, generate: async () => ++calls % 2 === 1 ? quality : { ...output, confidence: calls === 2 ? 0.9 : 0.3 } });
  const first = await f.begin(); await terminal(f.service, f.principal, first.id); await f.service.confirm(f.principal, first.id, 0);
  const second = await f.begin(1);
  assert.notEqual(first.id, second.id);
  assert.equal((await terminal(f.service, f.principal, second.id)).status, "LOW_CONFIDENCE");
  await assert.rejects(f.service.confirm(f.principal, second.id, 1));
  assert.equal((await f.service.profile(f.principal)).personal_color?.analysis_id, first.id);
});

test("portrait quality fails before color inference; malformed output fails without modifying profile", async () => {
  let calls = 0;
  const f = await fixture({ ready: () => true, generate: async () => { calls++; return { ...quality, filter_free: false }; } });
  const a = await f.begin();
  assert.equal((await terminal(f.service, f.principal, a.id)).status, "VALIDATION_FAILED");
  assert.equal(calls, 1);
  assert.equal((await f.service.profile(f.principal)).personal_color, null);
  const invalid = await fixture({ ready: () => true, generate: async () => ++calls === 2 ? quality : { ...output, palette: ["hallucinated"] } });
  const b = await invalid.begin();
  assert.equal((await terminal(invalid.service, invalid.principal, b.id)).status, "FAILED");
});

test("technical corrupt image is rejected without any model call", async () => {
  let calls = 0;
  const f = await fixture();
  const service = new PersonalColorService(f.repo, { ...f.assets, readOwnedAsset: async () => ({ bytes: Buffer.from("corrupt PNG data"), mime: "image/png", expires_at: new Date(Date.now() + 60000).toISOString() }) }, { ready: () => true, generate: async () => { calls++; return quality; } }, policy);
  const a = await service.analyze(f.principal, { asset_id: randomUUID(), consent: true, policy_version: policy.version, expected_version: 0 });
  assert.equal((await terminal(service, f.principal, a.id)).status, "VALIDATION_FAILED"); assert.equal(calls, 0);
});

test("cancel and timeout remain terminal when a noncooperative model returns late", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const started = Promise.withResolvers<void>(), response = Promise.withResolvers<unknown>();
  const f = await fixture({ ready: () => true, generate: () => { started.resolve(); return response.promise; } }, { timeoutMs: 30 });
  const a = await f.begin();
  await started.promise;
  await f.service.cancel(f.principal, a.id); response.resolve(quality);
  assert.equal((await terminal(f.service, f.principal, a.id)).status, "CANCELLED");
  const timeoutStarted = Promise.withResolvers<void>(), never = Promise.withResolvers<unknown>();
  const timeout = await fixture({ ready: () => true, generate: () => { timeoutStarted.resolve(); return never.promise; } }, { timeoutMs: 20 });
  const b = await timeout.begin();
  await timeoutStarted.promise;
  context.mock.timers.tick(30);
  assert.equal((await terminal(timeout.service, timeout.principal, b.id)).status, "TIMEOUT");
  assert.equal((await timeout.service.profile(timeout.principal)).personal_color, null);
});

test("ownership, explicit consent, stale profile versions and disabled runtime never permit confirmation", async () => {
  const f = await fixture();
  await assert.rejects(f.service.analyze(f.principal, { asset_id: randomUUID(), expected_version: 0, consent: false, policy_version: policy.version }));
  const a = await f.begin(); await terminal(f.service, f.principal, a.id);
  const other: ColorPrincipal = { owner: `guest:gs_${randomUUID()}`, guestId: `gs_${randomUUID()}` };
  await assert.rejects(f.service.get(other, a.id)); await assert.rejects(f.service.cancel(other, a.id)); await assert.rejects(f.service.confirm(other, a.id, 0));
  guestStyleProfiles.set(f.principal.guestId!, { ...guestStyleProfiles.get(f.principal.guestId!), style_profile_version: 1 });
  await assert.rejects(f.service.confirm(f.principal, a.id, 0)); await assert.rejects(f.begin(0));
  assert.equal((await f.service.profile(f.principal)).personal_color, null);
  const disabled = new PersonalColorService(f.repo, f.assets, { ready: () => true, generate: async () => output }, null);
  assert.equal(disabled.capabilities().enabled, false); await assert.rejects(disabled.analyze(f.principal, {}));
  assert.throws(() => colorPrincipal({ headers: { authorization: "Bearer invalid", "x-guest-session-id": f.principal.guestId } }, { authUser: null } as AuthContext));
});
