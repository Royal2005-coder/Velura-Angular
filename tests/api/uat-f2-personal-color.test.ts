/**
 * Feature Spec F2 — Personal Color Scientific CIE L*a*b* ITA° Optics & `gemini-decision-1` 4-Season Engine.
 *
 * Independently runnable:
 *   node --import tsx --test tests/api/uat-f2-personal-color.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { UnifiedDecisionService, measurePortraitSkinOptics } from "../../apps/api/src/decision/decision-service.js";
import { DEFAULT_PERSONAL_COLOR_POLICY } from "../../apps/api/src/personal-color/personal-color-policy.js";
import { PersonalColorService } from "../../apps/api/src/personal-color/personal-color-service.js";
import type {
  ColorAnalysis,
  ColorAssets,
  ColorPrincipal,
  ColorProfileResponse,
  ColorRepository,
  ColorVision,
} from "../../apps/api/src/personal-color/personal-color-types.js";
import { choice, getCachedSyntheticImage, mockDecisionResult, noul, withScrubbedAiEnv } from "./helpers/decision-test-kit.js";

const FOUR_SEASONS = ["Spring", "Summer", "Autumn", "Winter"] as const;
const DEPTHS = ["FAIR", "LIGHT", "MEDIUM", "TAN", "DEEP"] as const;
const UNDERTONES = ["WARM", "COOL", "NEUTRAL"] as const;
const CONTRASTS = ["LOW", "MEDIUM", "HIGH"] as const;

test("F2.1: measurePortraitSkinOptics separates ITA° >= 28° LIGHT_TONE vs < 28° DARK_TONE, detects EXTREME_CAST, and flags solid blank images", async () => {
  const [lightPortrait, darkPortrait, neonBlueCastPortrait, solidBlank] = await Promise.all([
    getCachedSyntheticImage("f2-light", { bg: [242, 242, 242], subject: [232, 198, 178], sclera: [246, 246, 247] }),
    getCachedSyntheticImage("f2-dark", { bg: [240, 240, 240], subject: [108, 72, 54], sclera: [244, 244, 245] }),
    getCachedSyntheticImage("f2-neon", { bg: [160, 210, 248], subject: [170, 185, 235], sclera: [160, 210, 248] }),
    getCachedSyntheticImage("f2-blank", { bg: [120, 120, 120], subject: [120, 120, 120], solidOnly: true }),
  ]);

  const lightOptics = await measurePortraitSkinOptics(lightPortrait);
  const darkOptics = await measurePortraitSkinOptics(darkPortrait);
  const neonOptics = await measurePortraitSkinOptics(neonBlueCastPortrait);
  const blankOptics = await measurePortraitSkinOptics(solidBlank);

  assert.ok(lightOptics.itaAngle >= 28, `Expected light ITA° >= 28°, got ${lightOptics.itaAngle}°`);
  assert.equal(lightOptics.measuredBaseDepth, "LIGHT_TONE");
  assert.equal(lightOptics.isBlankSolid, false);

  assert.ok(darkOptics.itaAngle < 28, `Expected dark ITA° < 28°, got ${darkOptics.itaAngle}°`);
  assert.equal(darkOptics.measuredBaseDepth, "DARK_TONE");
  assert.equal(darkOptics.isBlankSolid, false);

  assert.equal(neonOptics.whiteBalanceShift, "EXTREME_CAST");
  assert.equal(blankOptics.isBlankSolid, true);
});

test("F2.2: decidePersonalColor enforces signed CIE ITA° override when VLM confidence < 0.78 and returns null season + empty palettes on RETAKE", async () => {
  const [lightPortrait, darkPortrait, blankPortrait] = await Promise.all([
    getCachedSyntheticImage("f2-light", { bg: [242, 242, 242], subject: [232, 198, 178] }),
    getCachedSyntheticImage("f2-dark", { bg: [240, 240, 240], subject: [98, 64, 48] }),
    getCachedSyntheticImage("f2-blank", { bg: [120, 120, 120], subject: [120, 120, 120], solidOnly: true }),
  ]);

  // 1. Dark portrait (ITA° < 20° / negative) where uncertain VLM (0.71 < 0.78) wrongly guessed LIGHT_TONE -> MUST override to DARK_TONE (`P0-05`)
  const darkOverrideSvc = new UnifiedDecisionService(async () =>
    mockDecisionResult({
      lighting_valid: noul(0.95),
      skin_visible: noul(0.96),
      blur_free: noul(0.94),
      filter_free: noul(0.95),
      base_skin_depth: choice("LIGHT_TONE", ["LIGHT_TONE", "DARK_TONE"], 0.71),
      skin_depth: choice("TAN", DEPTHS, 0.88),
      undertone: choice("WARM", UNDERTONES, 0.90),
      contrast_level: choice("MEDIUM", CONTRASTS, 0.86),
      personal_season: choice("Autumn", FOUR_SEASONS, 0.91),
    }),
  );
  const darkDecision = await darkOverrideSvc.decidePersonalColor({ bytes: darkPortrait, mime: "image/jpeg" });
  assert.equal(darkDecision.lighting_valid, "PASS");
  assert.equal(darkDecision.base_skin_depth, "DARK_TONE");
  assert.equal(darkDecision.season, "Autumn");
  assert.ok(darkDecision.recommended_palette_ids.includes("terracotta"));
  assert.ok(!darkDecision.recommended_palette_ids.some((id) => darkDecision.avoid_palette_ids.includes(id)));

  // 2. Light portrait (ITA° > 35°) where uncertain VLM (0.74 < 0.78) wrongly guessed DARK_TONE -> MUST override to LIGHT_TONE
  const lightOverrideSvc = new UnifiedDecisionService(async () =>
    mockDecisionResult({
      lighting_valid: noul(0.95),
      skin_visible: noul(0.96),
      blur_free: noul(0.94),
      filter_free: noul(0.95),
      base_skin_depth: choice("DARK_TONE", ["LIGHT_TONE", "DARK_TONE"], 0.74),
      skin_depth: choice("FAIR", DEPTHS, 0.89),
      undertone: choice("COOL", UNDERTONES, 0.92),
      contrast_level: choice("LOW", CONTRASTS, 0.88),
      personal_season: choice("Summer", FOUR_SEASONS, 0.90),
    }),
  );
  const lightDecision = await lightOverrideSvc.decidePersonalColor({ bytes: lightPortrait, mime: "image/jpeg" });
  assert.equal(lightDecision.base_skin_depth, "LIGHT_TONE");
  assert.equal(lightDecision.season, "Summer");
  assert.ok(lightDecision.recommended_palette_ids.includes("lavender"));

  // 3. Solid blank image OR blurry/filtered selfie -> RETAKE with season === null and empty palettes (`P1-02`)
  const retakeDecision = await lightOverrideSvc.decidePersonalColor({ bytes: blankPortrait, mime: "image/jpeg" });
  assert.equal(retakeDecision.lighting_valid, "RETAKE");
  assert.equal(retakeDecision.season, null);
  assert.deepEqual(retakeDecision.recommended_palette_ids, []);
  assert.deepEqual(retakeDecision.avoid_palette_ids, []);
  assert.ok(retakeDecision.failed_checks.includes("skin_visible"));
});

test("F2.3: PersonalColorService enforces consent, strips actorId during preview analysis, supports shadow mode, and confirms profile", async () => {
  const portraitBytes = await getCachedSyntheticImage("f2-svc-portrait", {
    width: 320,
    height: 320,
    bg: [242, 242, 242],
    subject: [228, 192, 172],
  });
  const assetId = "11111111-2222-4333-8444-555555555555";
  const principal: ColorPrincipal = {
    owner: "user:member-99",
    userId: "99999999-2222-4333-8444-555555555555",
  };

  const analyses = new Map<string, ColorAnalysis>();
  let currentProfile: ColorProfileResponse = { version: 1, personal_color: null };
  const capturedActorIds: Array<string | null | undefined> = [];

  const repo: ColorRepository = {
    profile: async () => currentProfile,
    begin: async (_p, row) => {
      analyses.set(row.id, row);
      return row;
    },
    get: async (_p, id) => {
      const found = analyses.get(id);
      if (!found) throw new Error("NOT_FOUND");
      return found;
    },
    finish: async (_p, id, patch) => {
      const prev = analyses.get(id);
      const next = { ...(prev as ColorAnalysis), ...patch };
      analyses.set(id, next);
      return next;
    },
    cancel: async (_p, id) => {
      const prev = analyses.get(id);
      if (!prev) return null;
      const updated: ColorAnalysis = { ...prev, status: "CANCELLED" };
      analyses.set(id, updated);
      return updated;
    },
    confirm: async (_p, id, expectedVersion) => {
      const finished = analyses.get(id);
      assert.ok(finished?.result);
      currentProfile = {
        version: expectedVersion + 1,
        personal_color: {
          ...finished.result,
          status: "CONFIRMED",
          analysis_id: id,
          confirmed_at: new Date().toISOString(),
        },
      };
      return currentProfile;
    },
    confirmManual: async (_p, data, expectedVersion) => {
      currentProfile = {
        version: expectedVersion + 1,
        personal_color: {
          ...data,
          status: "CONFIRMED",
          analysis_id: "manual-1",
          confirmed_at: new Date().toISOString(),
        },
      };
      return currentProfile;
    },
  };

  const assets: ColorAssets = {
    upload: async () => ({ asset_id: assetId, expires_at: new Date(Date.now() + 60_000).toISOString() }),
    readOwnedAsset: async () => ({
      bytes: portraitBytes,
      mime: "image/jpeg",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
    deleteOwnedAsset: async () => undefined,
  };

  let legacyCalls = 0;
  const vision: ColorVision = {
    ready: () => true,
    decide: async (_img, opts) => {
      capturedActorIds.push(opts?.actorId);
      return {
        lighting_valid: "PASS",
        failed_checks: [],
        base_skin_depth: "LIGHT_TONE",
        skin_depth: "LIGHT",
        undertone: "WARM",
        contrast_level: "MEDIUM",
        season: "Spring",
        confidence_score: 0.92,
        requires_human_review: false,
        recommended_palette_ids: ["peach", "coral", "gold", "mint"],
        avoid_palette_ids: ["black", "burgundy"],
        recommended_hex_palette: ["#F7B299", "#EE7B68"],
        avoid_hex_palette: ["#1C1C1E"],
        optical_measurement: {
          luminanceL: 72,
          redGreenA: 11,
          yellowBlueB: 19,
          itaAngle: 49.2,
          whiteBalanceShift: "BALANCED",
          measuredBaseDepth: "LIGHT_TONE",
          isBlankSolid: false,
        },
      };
    },
    generate: async (prompt) => {
      legacyCalls += 1;
      if (prompt.includes("lighting_valid")) {
        return { lighting_valid: true, skin_visible: true, blur_free: true, filter_free: true };
      }
      return { season: "Winter", subtype: "Winter", palette: ["emerald", "royal_blue"], avoided: ["peach"], confidence: 0.88 };
    },
  };

  const service = new PersonalColorService(repo, assets, vision, DEFAULT_PERSONAL_COLOR_POLICY);

  // Missing consent -> 400 COLOR_CONSENT_REQUIRED
  await assert.rejects(
    () => service.analyze(principal, { consent: false, policy_version: DEFAULT_PERSONAL_COLOR_POLICY.version, asset_id: assetId, expected_version: 1 }),
    /Xác nhận đồng ý/,
  );

  // Active mode -> uses Decision Engine Spring result and strips actorId (`actorId === null`) before confirmation
  await withScrubbedAiEnv({ AI_DECISION_ROLLOUT_MODE: "active" }, async () => {
    const started = await service.analyze(principal, {
      consent: true,
      policy_version: DEFAULT_PERSONAL_COLOR_POLICY.version,
      asset_id: assetId,
      expected_version: 1,
    });
    await waitUntilDone(() => analyses.get(started.id));
    const done = await service.get(principal, started.id);
    assert.equal(done.status, "SUCCESS");
    assert.equal(done.result?.season, "Spring");
    assert.equal(capturedActorIds[0], null, "Preview analysis must never persist raw user UUID before explicit confirmation");

    const confirmed = await service.confirm(principal, started.id, 1);
    assert.equal(confirmed.version, 2);
    assert.equal(confirmed.personal_color?.season, "Spring");
  });

  // Shadow mode -> calls vision.decide for shadow telemetry, then falls back to legacy vision.generate (`Winter`)
  await withScrubbedAiEnv({ AI_DECISION_ROLLOUT_MODE: "shadow" }, async () => {
    const started = await service.analyze(principal, {
      consent: true,
      policy_version: DEFAULT_PERSONAL_COLOR_POLICY.version,
      asset_id: assetId,
      expected_version: 2,
    });
    await waitUntilDone(() => analyses.get(started.id));
    const done = await service.get(principal, started.id);
    assert.equal(done.status, "SUCCESS");
    assert.equal(done.result?.season, "Winter");
    assert.ok(legacyCalls >= 2);
  });
});

async function waitUntilDone(read: () => ColorAnalysis | undefined): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const cur = read();
    if (cur && cur.status !== "RUNNING") return;
    await new Promise((r) => setTimeout(r, 35));
  }
}
