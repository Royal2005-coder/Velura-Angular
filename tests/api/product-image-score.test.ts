import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { config } from "../../apps/api/src/config.js";
import { analyzeProductImageQuality, enhanceProductImageStudio } from "../../apps/api/src/products/product-ai-studio.js";
import { requireEnhancementQuality } from "../../apps/api/src/ai/enhancement-approval-service.js";

test("Studio scores the exact output bytes without granting an automatic improvement or pass", async () => {
  const saved = { ...config };
  const disabled = process.env.AI_DISABLE;
  Object.assign(config, { supabaseUrl: "", supabaseServiceRoleKey: "", supabaseAnonKey: "" });
  process.env.AI_DISABLE = "true";
  try {
    const input = await sharp({ create: { width: 640, height: 640, channels: 3, background: '#000000' } }).png().toBuffer();
    const result = await enhanceProductImageStudio({
      imageBase64: input.toString('base64'), mimeType: 'image/png',
      options: { background: 'keep', lighting: false, sharpness: false, upscale: false },
    });
    const reread = await analyzeProductImageQuality({ imageBase64: result.previewDataUrl, mimeType: 'image/png' });
    assert.equal(result.afterAnalysis.overallScore, reread.overallScore);
    assert.equal(result.afterAnalysis.passed, reread.passed);
    assert.equal(result.afterAnalysis.grade, reread.grade);
    assert.equal(result.afterAnalysis.needsEnhancement, reread.needsEnhancement);
    assert.deepEqual(result.afterAnalysis.metrics, reread.metrics);
    assert.equal(result.afterAnalysis.passed, false, 'A blank dark image must not become approved merely by being processed');
  } finally {
    Object.assign(config, saved);
    if (disabled === undefined) delete process.env.AI_DISABLE; else process.env.AI_DISABLE = disabled;
  }
});

test("KAN-123: dim/cluttered product photo fails initial check then passes Studio enhancement and approval gate", async () => {
  const saved = { ...config };
  const disabled = process.env.AI_DISABLE;
  Object.assign(config, { supabaseUrl: "", supabaseServiceRoleKey: "", supabaseAnonKey: "" });
  process.env.AI_DISABLE = "true";
  try {
    const width = 420;
    const height = 420;
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;
        const inGarment = x >= 110 && x <= 310 && y >= 70 && y <= 350;
        if (inGarment) {
          // Textured dim burgundy blouse in center
          const weave = ((x + y) % 6 === 0) ? 18 : 0;
          raw[idx] = 74 + weave;
          raw[idx + 1] = 28 + weave;
          raw[idx + 2] = 38 + weave;
        } else {
          // Dark cluttered room backdrop
          const clutter = ((x * 7 + y * 13) % 45);
          raw[idx] = 35 + clutter;
          raw[idx + 1] = 32 + clutter;
          raw[idx + 2] = 30 + clutter;
        }
      }
    }
    const input = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();

    const enhanced = await enhanceProductImageStudio({
      imageBase64: input.toString('base64'),
      mimeType: 'image/png',
      options: { background: 'studio_white', lighting: true, sharpness: true, upscale: true },
    });

    assert.equal(enhanced.beforeAnalysis.passed, false);
    assert.equal(enhanced.beforeAnalysis.needsEnhancement, true);

    assert.equal(enhanced.afterAnalysis.passed, true);
    assert.equal(enhanced.afterAnalysis.needsEnhancement, false);
    assert.ok(enhanced.afterAnalysis.overallScore >= 78);
    assert.equal(enhanced.afterAnalysis.criteria.some((c) => c.status === 'poor'), false);

    assert.doesNotThrow(() =>
      requireEnhancementQuality({
        valid: enhanced.afterAnalysis.passed || (enhanced.afterAnalysis.overallScore >= 70 && !enhanced.afterAnalysis.criteria.some((c) => c.status === 'poor')),
        metrics: {
          brightness: enhanced.afterAnalysis.metrics.brightness,
          sharpness: enhanced.afterAnalysis.metrics.sharpnessScore,
          background_score: enhanced.afterAnalysis.metrics.backgroundScore,
        },
      }),
    );
  } finally {
    Object.assign(config, saved);
    if (disabled === undefined) delete process.env.AI_DISABLE; else process.env.AI_DISABLE = disabled;
  }
});
