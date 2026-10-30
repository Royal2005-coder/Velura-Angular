import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { asJsonObject, asString, isJsonObject, type JsonObject } from "../types.js";

/** Registry plus the root all asset files are resolved against. */
export interface StudioAssetSource {
  root: string;
  registry: Record<string, JsonObject>;
}

function parseRegistry(value: string | undefined): Record<string, JsonObject> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isJsonObject(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, asset]) => [key, asJsonObject(asset)]));
  } catch {
    return {};
  }
}

function manifestRegistry(root: string): Record<string, JsonObject> {
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) return {};
  try {
    const manifest = asJsonObject(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
    if (manifest.subjects_are_fictional !== true) return {};
    const assets = Array.isArray(manifest.assets) ? manifest.assets.map(asJsonObject) : [];
    const registry: Record<string, JsonObject> = {};
    for (const asset of assets) {
      const id = asString(asset.id);
      if (/^[a-zA-Z0-9_-]{1,64}$/.test(id) && asString(asset.file)) {
        registry[id] = { ...asset, licensed: asset.licensed === false ? false : true };
      }
    }
    return registry;
  } catch {
    return {};
  }
}

/**
 * Explicit environment configuration wins. When it is absent, the image's bundled
 * `manifest.json` is used, because a missing ConfigMap value must not hide licensed studio
 * assets that were copied into the image.
 */
export function loadStudioAssets(): StudioAssetSource {
  const configured = parseRegistry(process.env.AI_STUDIO_ASSETS);
  const envRoot = resolve(process.env.AI_STUDIO_ASSET_ROOT || "scratch/ai-studio");
  if (Object.keys(configured).length) return { root: envRoot, registry: configured };
  const candidates = [
    envRoot,
    resolve("studio-assets"),
    resolve(process.env.AI_PRIVATE_ROOT || "scratch/ai-private", "studio"),
    resolve("apps/ai-worker/assets/studio"),
    resolve("scratch/ai-studio"),
  ].filter((root, index, all) => all.indexOf(root) === index);
  for (const root of candidates) {
    const registry = manifestRegistry(root);
    if (Object.keys(registry).length) return { root, registry };
  }
  return { root: envRoot, registry: {} };
}
