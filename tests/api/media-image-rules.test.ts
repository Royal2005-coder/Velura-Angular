import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { HttpError } from "../../apps/api/src/http.js";
import {
  CMS_UPLOAD_PREFIX,
  parseUploadCategory,
  validateCmsUpload,
} from "../../apps/api/src/content/media-image-rules.js";

const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };
const SOLID = { r: 200, g: 50, b: 60, alpha: 1 };

/** PNG RGBA `width`×`height` trong suốt hoàn toàn, chồng một khối đục ở giữa (`share` = tỉ lệ cạnh khối). */
async function cutoutPng(width: number, height: number, share = 0.5, format: "png" | "webp" = "png"): Promise<Buffer> {
  const bw = Math.round(width * share);
  const bh = Math.round(height * share);
  const base = sharp({ create: { width, height, channels: 4, background: CLEAR } }).composite([
    {
      input: { create: { width: bw, height: bh, channels: 4, background: SOLID } },
      left: Math.round((width - bw) / 2),
      top: Math.round((height - bh) / 2),
    },
  ]);
  return format === "webp" ? base.webp({ lossless: true }).toBuffer() : base.png().toBuffer();
}

async function rejectsWith(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof HttpError && err.code === code && err.status === status);
}

const model = (buffer: Buffer, mimeType = "image/png") => validateCmsUpload({ category: "collection-model", buffer, mimeType });
const cover = (buffer: Buffer, mimeType = "image/jpeg") => validateCmsUpload({ category: "collection-cover", buffer, mimeType });

test("parseUploadCategory: accepts the four categories, defaults to media, rejects others", () => {
  for (const category of ["banner", "collection-cover", "collection-model", "media"] as const) {
    assert.equal(parseUploadCategory(category), category);
  }
  assert.equal(parseUploadCategory(null), "media");
  assert.equal(parseUploadCategory(""), "media");
  for (const bad of ["collection", "models", "../etc", "BANNER"]) {
    assert.throws(() => parseUploadCategory(bad), (err: unknown) => err instanceof HttpError && err.status === 400 && err.code === "INVALID_UPLOAD_CATEGORY");
  }
});

test("CMS_UPLOAD_PREFIX: storage prefixes per category", () => {
  assert.deepEqual(CMS_UPLOAD_PREFIX, {
    banner: "banners",
    "collection-cover": "collections/covers",
    "collection-model": "collections/models",
    media: "cms-media",
  });
});

test("model: transparent PNG 800x1400 with an opaque subject is accepted", async () => {
  assert.deepEqual(await model(await cutoutPng(800, 1400)), { ok: true });
});

test("model: lossless WebP cutout is accepted", async () => {
  assert.deepEqual(await model(await cutoutPng(800, 1400, 0.5, "webp"), "image/webp"), { ok: true });
});

test("model: PNG without an alpha channel is MODEL_ALPHA_REQUIRED", async () => {
  const rgb = await sharp({ create: { width: 800, height: 1400, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  await rejectsWith(model(rgb), "MODEL_ALPHA_REQUIRED", 422);
});

test("model: RGBA image with opaque corners is MODEL_ALPHA_REQUIRED", async () => {
  const opaque = await sharp({ create: { width: 800, height: 1400, channels: 4, background: SOLID } }).png().toBuffer();
  await rejectsWith(model(opaque), "MODEL_ALPHA_REQUIRED", 422);
});

test("model: a single opaque corner pixel patch is enough to reject", async () => {
  const withCorner = await sharp({ create: { width: 800, height: 1400, channels: 4, background: CLEAR } })
    .composite([
      { input: { create: { width: 400, height: 700, channels: 4, background: SOLID } }, left: 200, top: 350 },
      { input: { create: { width: 8, height: 8, channels: 4, background: SOLID } }, left: 792, top: 1392 },
    ])
    .png()
    .toBuffer();
  await rejectsWith(model(withCorner), "MODEL_ALPHA_REQUIRED", 422);
});

test("model: mostly opaque image with transparent corners fails the transparency share", async () => {
  const mostlyOpaque = await sharp({ create: { width: 800, height: 1400, channels: 4, background: SOLID } })
    .composite([
      { input: { create: { width: 20, height: 20, channels: 4, background: CLEAR } }, left: 0, top: 0 },
      { input: { create: { width: 20, height: 20, channels: 4, background: CLEAR } }, left: 780, top: 0 },
      { input: { create: { width: 20, height: 20, channels: 4, background: CLEAR } }, left: 0, top: 1380 },
      { input: { create: { width: 20, height: 20, channels: 4, background: CLEAR } }, left: 780, top: 1380 },
    ])
    .png()
    .toBuffer();
  await rejectsWith(model(mostlyOpaque), "MODEL_ALPHA_REQUIRED", 422);
});

test("model: fully transparent image has no subject", async () => {
  const empty = await sharp({ create: { width: 800, height: 1400, channels: 4, background: CLEAR } }).png().toBuffer();
  await rejectsWith(model(empty), "MODEL_ALPHA_REQUIRED", 422);
});

test("model: too narrow or wrong aspect ratio is MODEL_DIMENSIONS_INVALID", async () => {
  await rejectsWith(model(await cutoutPng(400, 700)), "MODEL_DIMENSIONS_INVALID", 422);
  await rejectsWith(model(await cutoutPng(800, 800)), "MODEL_DIMENSIONS_INVALID", 422);
  await rejectsWith(model(await cutoutPng(700, 2000)), "MODEL_DIMENSIONS_INVALID", 422);
});

test("model: JPEG, GIF and non-image data are MODEL_FORMAT_INVALID", async () => {
  const jpeg = await sharp({ create: { width: 800, height: 1400, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
  await rejectsWith(model(jpeg, "image/jpeg"), "MODEL_FORMAT_INVALID", 422);
  await rejectsWith(model(Buffer.from("not an image at all"), "image/png"), "MODEL_FORMAT_INVALID", 422);
});

test("cover: JPEG 1672x941 is accepted; PNG and WebP too", async () => {
  const jpeg = await sharp({ create: { width: 1672, height: 941, channels: 3, background: { r: 230, g: 210, b: 200 } } }).jpeg().toBuffer();
  assert.deepEqual(await cover(jpeg), { ok: true });
  const png = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 230, g: 210, b: 200 } } }).png().toBuffer();
  assert.deepEqual(await cover(png, "image/png"), { ok: true });
  const webp = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 230, g: 210, b: 200 } } }).webp().toBuffer();
  assert.deepEqual(await cover(webp, "image/webp"), { ok: true });
});

test("cover: narrow or wrong aspect ratio is MODEL_DIMENSIONS_INVALID", async () => {
  const square = await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
  await rejectsWith(cover(square), "MODEL_DIMENSIONS_INVALID", 422);
  const ultrawide = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
  await rejectsWith(cover(ultrawide), "MODEL_DIMENSIONS_INVALID", 422);
  const small = await sharp({ create: { width: 1200, height: 675, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
  await rejectsWith(cover(small), "MODEL_DIMENSIONS_INVALID", 422);
});

test("cover: GIF is MODEL_FORMAT_INVALID", async () => {
  const gif = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 1, g: 2, b: 3 } } }).gif().toBuffer();
  await rejectsWith(cover(gif, "image/gif"), "MODEL_FORMAT_INVALID", 422);
});

test("video is VIDEO_NOT_ALLOWED outside the banner category", async () => {
  const video = Buffer.from("fake mp4 bytes");
  for (const category of ["collection-cover", "collection-model", "media"] as const) {
    await rejectsWith(validateCmsUpload({ category, buffer: video, mimeType: "video/mp4" }), "VIDEO_NOT_ALLOWED", 400);
  }
  assert.deepEqual(await validateCmsUpload({ category: "banner", buffer: video, mimeType: "video/mp4" }), { ok: true });
});

test("banner and media images are not pixel-validated", async () => {
  const anyImage = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
  assert.deepEqual(await validateCmsUpload({ category: "banner", buffer: anyImage, mimeType: "image/jpeg" }), { ok: true });
  assert.deepEqual(await validateCmsUpload({ category: "media", buffer: anyImage, mimeType: "image/jpeg" }), { ok: true });
});
