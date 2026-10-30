import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStudioAssets } from "../../apps/api/src/ai/studio-assets.js";

test("bundled synthetic manifest exposes licensed studio assets without env JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "velura-studio-"));
  const previous = { assets: process.env.AI_STUDIO_ASSETS, roots: process.env.AI_STUDIO_ASSET_ROOT, privateRoot: process.env.AI_PRIVATE_ROOT };
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      subjects_are_fictional: true,
      assets: [{ id: "female-front-v1", file: "female-front-v1.png", label: "Người mẫu nữ", gender: "female" }],
    }));
    writeFileSync(join(root, "female-front-v1.png"), "fixture");
    process.env.AI_STUDIO_ASSETS = "";
    process.env.AI_STUDIO_ASSET_ROOT = root;
    const loaded = loadStudioAssets();
    assert.equal(loaded.root, root);
    assert.equal(loaded.registry["female-front-v1"]?.licensed, true);
    assert.equal(loaded.registry["female-front-v1"]?.file, "female-front-v1.png");
  } finally {
    if (previous.assets === undefined) delete process.env.AI_STUDIO_ASSETS;
    else process.env.AI_STUDIO_ASSETS = previous.assets;
    if (previous.roots === undefined) delete process.env.AI_STUDIO_ASSET_ROOT;
    else process.env.AI_STUDIO_ASSET_ROOT = previous.roots;
    if (previous.privateRoot === undefined) delete process.env.AI_PRIVATE_ROOT;
    else process.env.AI_PRIVATE_ROOT = previous.privateRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit environment registry still wins over the manifest", () => {
  const previous = process.env.AI_STUDIO_ASSETS;
  try {
    process.env.AI_STUDIO_ASSETS = JSON.stringify({ custom: { file: "custom.png", licensed: true, label: "Custom" } });
    const loaded = loadStudioAssets();
    assert.deepEqual(Object.keys(loaded.registry), ["custom"]);
    assert.equal(loaded.registry["custom"]?.label, "Custom");
  } finally {
    if (previous === undefined) delete process.env.AI_STUDIO_ASSETS;
    else process.env.AI_STUDIO_ASSETS = previous;
  }
});
