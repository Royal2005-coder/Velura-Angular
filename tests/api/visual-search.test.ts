import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { HttpError } from "../../apps/api/src/http.js";
import { VisualSearchService, decodeSearchImage, rankVisualMatches, type VisualProviders } from "../../apps/api/src/visual-search/visual-search-service.js";
import { validateAttributes, validateExtraction, validateFilters, type VisualCandidate } from "../../apps/api/src/visual-search/visual-search-types.js";
import type { VisualSearchRepository } from "../../apps/api/src/visual-search/visual-search-repository.js";
import { readVisualUpload } from "../../apps/api/src/visual-search/visual-search-router.js";

const attributes = { category: "dress", color: "black", fit: "regular", material: null, style: "minimal" };
const extracted = { is_clothing: true, garment_count: 1, attributes };
const vector = Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0);
function fixture(overrides: Partial<VisualProviders> = {}, profile: Record<string, unknown> | null = null, timeout = 15000) {
  let extractionCalls = 0, embeddingCalls = 0, searchCalls = 0, version = "1";
  let lastText = "", lastFilters: unknown;
  const repo: VisualSearchRepository = {
    async profile() { return profile; },
    async search(_vector, filters) { searchCalls++; lastFilters = filters; return { matches: [{ product_id: "match", similarity: 0.45, status: "on_sale" }], featured: [], catalog_version: version }; },
  };
  const providers: VisualProviders = {
    async decode(bytes) { return Buffer.from(bytes); },
    async extract() { extractionCalls++; return extracted; },
    async embed(text) { embeddingCalls++; lastText = text; return vector; },
    ...overrides,
  };
  const service = new VisualSearchService(repo, providers, timeout);
  return { service, repo, setVersion(value: string) { version = value; }, counters: () => ({ extractionCalls, embeddingCalls, searchCalls, lastText, lastFilters }) };
}

test("Decode rejects unreadable, wrong MIME, over-5MB and non-raster sources", async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
  assert.ok((await decodeSearchImage(png, "image/png")).length > 0);
  await assert.rejects(decodeSearchImage(png, "image/jpeg"), { code: "VISUAL_IMAGE_UNREADABLE" });
  await assert.rejects(decodeSearchImage(Buffer.alloc(5 * 1024 * 1024 + 1), "image/png"), { code: "VISUAL_IMAGE_SIZE" });
  await assert.rejects(decodeSearchImage(Buffer.from("not an image"), "image/png"), { code: "VISUAL_IMAGE_UNREADABLE" });
  await assert.rejects(decodeSearchImage(png, "image/gif"), { code: "VISUAL_IMAGE_TYPE" });
});

test("Structured extraction rejects nonclothing, multiple garments and invented attribute types", () => {
  assert.throws(() => validateExtraction({ ...extracted, is_clothing: false }), { code: "ONE_GARMENT_REQUIRED" });
  assert.throws(() => validateExtraction({ ...extracted, garment_count: 2 }), { code: "ONE_GARMENT_REQUIRED" });
  assert.throws(() => validateAttributes({ ...attributes, material: ["cotton"] }), { code: "VISUAL_SEARCH_INVALID" });
  assert.throws(() => validateAttributes({ ...attributes, hidden: "prompt" }), { code: "VISUAL_SEARCH_INVALID" });
  assert.throws(() => validateFilters({ product_ids: ["not-a-uuid"] }), { code: "VISUAL_SEARCH_INVALID" });
  assert.deepEqual(validateFilters({ product_ids: [] }), { product_ids: [] });
});

test("Cosine .45 boundary, max20 and absent-profile order preserve semantic similarity", () => {
  const rows: VisualCandidate[] = Array.from({ length: 25 }, (_, i) => ({ product_id: String(i), status: "on_sale", similarity: 0.45 + i / 100 }));
  rows.push({ product_id: "below", similarity: 0.449999, status: "on_sale" }, { product_id: "hidden", similarity: 1, status: "hidden" });
  const ranked = rankVisualMatches(rows, null);
  assert.equal(ranked.length, 20); assert.equal(ranked[0].product_id, "24");
  assert.equal(rankVisualMatches([rows[0]], null)[0].similarity, 0.45);
  assert.ok(ranked.every(row => row.rank_score === row.similarity));
});

test("Confirmed profile reranks body/style/color/occasion/budget but cannot admit low similarity", () => {
  const profile = { body_shape: "pear", style_tags: ["minimal"], favorite_colors: ["black"], preferred_occasions: ["office"], budget_range: "under_300k" };
  const matched = { product_id: "personal", similarity: 0.45, status: "on_sale", suitable_body_shapes: ["Pear"], style_tags: ["minimal"], color_tone: "black", occasions: ["office"], sale_price: 200000 };
  const ranked = rankVisualMatches([matched, { product_id: "plain", similarity: 0.55, status: "on_sale" }, { ...matched, product_id: "below", similarity: 0.44 }], profile);
  assert.equal(ranked[0].product_id, "personal"); assert.equal(ranked.length, 2);
});

test("Source buffers are wiped after success; refinement removes attributes without upload/vision and reads new catalog version", async () => {
  const f = fixture(), bytes = Buffer.from("source-image");
  const result = await f.service.search("guest:a", randomUUID(), bytes, "image/png", {});
  assert.ok(bytes.every(value => value === 0));
  f.setVersion("2");
  const refined = await f.service.refine("guest:a", randomUUID(), { refinement_token: result.refinement_token, attributes: { ...attributes, color: null }, keywords: "linen", filters: { product_ids: [] } });
  assert.equal(refined.catalog_version, "2"); assert.equal(refined.attributes.color, null);
  assert.equal(f.counters().extractionCalls, 1); assert.equal(f.counters().embeddingCalls, 2);
  assert.ok(f.counters().lastText.includes("linen")); assert.ok(!f.counters().lastText.includes("black"));
  assert.deepEqual(f.counters().lastFilters, { product_ids: [] });
});

test("Foreign refinement tokens cannot read another owner and failed/no garment searches wipe sources before matching", async () => {
  const f = fixture();
  const result = await f.service.search("member:a", randomUUID(), Buffer.from("source"), "image/png", {});
  await assert.rejects(f.service.refine("member:b", randomUUID(), { refinement_token: result.refinement_token }), { code: "VISUAL_REFINEMENT_NOT_FOUND" });
  const bad = fixture({ async extract() { return { ...extracted, garment_count: 0 }; } });
  const bytes = Buffer.from("source");
  await assert.rejects(bad.service.search("guest:a", randomUUID(), bytes, "image/png", {}), { code: "ONE_GARMENT_REQUIRED" });
  assert.ok(bytes.every(value => value === 0)); assert.equal(bad.counters().embeddingCalls, 0); assert.equal(bad.counters().searchCalls, 0);
});

test("Body filtering requires a member and completed profile before embedding", async () => {
  const guest = fixture();
  await assert.rejects(guest.service.search("guest:a", randomUUID(), Buffer.from("source"), "image/png", { body_shape: "Pear" }), { code: "BODY_FILTER_MEMBER_REQUIRED" });
  const member = fixture();
  await assert.rejects(member.service.search("member:a", randomUUID(), Buffer.from("source"), "image/png", { body_shape: "Pear" }, "user-a"), { code: "BODY_FILTER_QUIZ_REQUIRED" });
  assert.equal(member.counters().embeddingCalls, 0);
});

test("Total deadline covers provider stalls and at most two retries across stages", async () => {
  let attempts = 0;
  const failed = fixture({ async extract() { attempts++; throw new HttpError(503, "PROVIDER_UNAVAILABLE", "unavailable"); } });
  const bytes = Buffer.from("source");
  await assert.rejects(failed.service.search("guest:a", randomUUID(), bytes, "image/png", {}), { code: "PROVIDER_UNAVAILABLE" });
  assert.equal(attempts, 3); assert.ok(bytes.every(value => value === 0));
  const stalled = fixture({ extract: () => new Promise(() => undefined) }, null, 100);
  const stalledBytes = Buffer.from("source");
  await assert.rejects(stalled.service.search("guest:a", randomUUID(), stalledBytes, "image/png", {}), { code: "VISUAL_SEARCH_TIMEOUT" });
  assert.ok(stalledBytes.every(value => value === 0));
});

test("Cancellation is owner-bound, handles pre-arrival cancellation and wipes buffers", async () => {
  let reached!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const f = fixture({ async extract() { reached(); return new Promise(() => undefined); } });
  const id = randomUUID(), bytes = Buffer.from("source");
  const pending = f.service.search("guest:a", id, bytes, "image/png", {});
  await waiting; f.service.cancel("guest:b", id); f.service.cancel("guest:a", id);
  await assert.rejects(pending, { code: "VISUAL_SEARCH_CANCELLED" }); assert.ok(bytes.every(value => value === 0));
  const early = randomUUID(), earlyBytes = Buffer.from("source"); f.service.cancel("guest:a", early);
  await assert.rejects(f.service.search("guest:a", early, earlyBytes, "image/png", {}), { code: "VISUAL_SEARCH_CANCELLED" });
  assert.ok(earlyBytes.every(value => value === 0));
});

test("Session rate limit counts failures and does not block unrelated sessions", () => {
  const f = fixture(); for (let i = 0; i < 15; i++) f.service.consume("guest:a");
  assert.throws(() => f.service.consume("guest:a"), { code: "VISUAL_SEARCH_RATE_LIMIT" });
  assert.doesNotThrow(() => f.service.consume("guest:b"));
});

test("No results return genuine featured products separately from matches", async () => {
  const f = fixture(); f.repo.search = async () => ({ matches: [], featured: [{ product_id: "featured", similarity: 0, status: "on_sale" }], catalog_version: "9" });
  const result = await f.service.search("guest:a", randomUUID(), Buffer.from("source"), "image/png", {});
  assert.deepEqual(result.matches, []); assert.equal(result.featured[0].product_id, "featured");
});

test("Multipart source bytes never remain in request chunks after parsing/release", async () => {
  const body = Buffer.from('--b\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nsource\r\n--b\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{"consent":true}\r\n--b--\r\n');
  const upload = await readVisualUpload({ headers: { "content-type": "multipart/form-data; boundary=b" }, async *[Symbol.asyncIterator]() { yield body; } });
  assert.ok(body.every(value => value === 0)); assert.equal(upload.bytes.toString(), "source");
  upload.release(); assert.ok(upload.bytes.every(value => value === 0));
});
