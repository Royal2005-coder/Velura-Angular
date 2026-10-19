import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { config } from "../../apps/api/src/config.js";
import { analyzeProductImageQuality, enhanceProductImageStudio } from "../../apps/api/src/products/product-ai-studio.js";

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
