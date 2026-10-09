import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { HttpError } from "../../apps/api/src/http.js";
import { VisualSearchService, decodeSearchImage, rankVisualMatches, type VisualProviders } from "../../apps/api/src/visual-search/visual-search-service.js";
import { dominantCategory, validateFilters, type VisualCandidate } from "../../apps/api/src/visual-search/visual-search-types.js";
import type { VisualSearchRepository } from "../../apps/api/src/visual-search/visual-search-repository.js";
import { readVisualUpload } from "../../apps/api/src/visual-search/visual-search-router.js";

const clipVector = Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0);
function neighbor(product_id: string, similarity: number, category_slug?: string): VisualCandidate {
  return { product_id, similarity, status: "on_sale", category_slug };
}
function fixture(overrides: Partial<VisualProviders> = {}, profile: Record<string, unknown> | null = null, timeout = 15000) {
  let embedCalls = 0, searchCalls = 0, version = "1";
  let lastFilters: unknown;
  let neighbors: VisualCandidate[] = [neighbor("match", 0.8, "ao")];
  let featured: VisualCandidate[] = [];
  const repo: VisualSearchRepository = {
    async profile() { return profile; },
    async imageSearch(_vector, filters) { searchCalls++; lastFilters = filters; return { neighbors, featured, catalog_version: version }; },
  };
  const providers: VisualProviders = {
    async decode(bytes) { return Buffer.from(bytes); },
    async embedImage() { embedCalls++; return clipVector; },
    ...overrides,
  };
  const service = new VisualSearchService(repo, providers, timeout);
  return { service, repo, setNeighbors(rows: VisualCandidate[]) { neighbors = rows; }, setFeatured(rows: VisualCandidate[]) { featured = rows; }, setVersion(value: string) { version = value; }, counters: () => ({ embedCalls, searchCalls, lastFilters }) };
}

test("Decode rejects unreadable, wrong MIME, over-5MB and non-raster sources", async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
  assert.ok((await decodeSearchImage(png, "image/png")).length > 0);
  await assert.rejects(decodeSearchImage(png, "image/jpeg"), { code: "VISUAL_IMAGE_UNREADABLE" });
  await assert.rejects(decodeSearchImage(Buffer.alloc(5 * 1024 * 1024 + 1), "image/png"), { code: "VISUAL_IMAGE_SIZE" });
  await assert.rejects(decodeSearchImage(Buffer.from("not an image"), "image/png"), { code: "VISUAL_IMAGE_UNREADABLE" });
  await assert.rejects(decodeSearchImage(png, "image/gif"), { code: "VISUAL_IMAGE_TYPE" });
});

test("Filters validation rejects unknown keys, foreign IDs and inverted prices", () => {
  assert.throws(() => validateFilters({ hidden: "prompt" }), { code: "VISUAL_SEARCH_INVALID" });
  assert.throws(() => validateFilters({ product_ids: ["not-a-uuid"] }), { code: "VISUAL_SEARCH_INVALID" });
  assert.throws(() => validateFilters({ min_price: 10, max_price: 5 }), { code: "VISUAL_SEARCH_INVALID" });
  assert.deepEqual(validateFilters({ product_ids: [] }), { product_ids: [] });
  assert.deepEqual(validateFilters(undefined), {});
});

test("Nearest neighbours vote for the detected category and rows without one abstain", () => {
  const rows = [neighbor("a", 0.8, "ao"), neighbor("b", 0.7, "ao"), neighbor("c", 0.69, "dam-vay"), neighbor("d", 0.68, undefined)];
  assert.equal(dominantCategory(rows), "ao");
  // Ties fall back to the category of the single closest neighbour.
  assert.equal(dominantCategory([neighbor("a", 0.8, "quan"), neighbor("b", 0.7, "ao")]), "quan");
  assert.equal(dominantCategory([neighbor("a", 0.8)]), null);
  assert.equal(dominantCategory([]), null);
  // Only the closest rows vote, so distant rows of another category cannot outvote the photograph.
  const mixed = [neighbor("a", 0.9, "ao"),
    ...Array.from({ length: 11 }, (_, i) => neighbor(`q${i}`, 0.85 - i / 100, "quan")),
    ...Array.from({ length: 20 }, (_, i) => neighbor(`g${i}`, 0.5 - i / 100, "giay-dep"))];
  assert.equal(dominantCategory(mixed), "quan");
});

test("CLIP .6 boundary, max20 and absent-profile order preserve visual similarity", () => {
  const rows: VisualCandidate[] = Array.from({ length: 25 }, (_, i) => neighbor(String(i), 0.6 + i / 100));
  rows.push(neighbor("below", 0.599999), neighbor("hidden", 1));
  rows[rows.length - 1].status = "hidden";
  const ranked = rankVisualMatches(rows, null);
  assert.equal(ranked.length, 20); assert.equal(ranked[0].product_id, "24");
  assert.equal(rankVisualMatches([rows[0]], null)[0].similarity, 0.6);
  assert.ok(ranked.every(row => row.rank_score === row.similarity));
  assert.deepEqual(rankVisualMatches([neighbor("x", 0.59)], null), []);
});

test("Confirmed profile reranks body/style/color/occasion/budget but cannot admit low similarity", () => {
  const profile = { body_shape: "pear", style_tags: ["minimal"], favorite_colors: ["black"], preferred_occasions: ["office"], budget_range: "under_300k" };
  const matched: VisualCandidate = { ...neighbor("personal", 0.6), suitable_body_shapes: ["Pear"], style_tags: ["minimal"], color_tone: "black", occasions: ["office"], sale_price: 200000 };
  const ranked = rankVisualMatches([matched, { ...neighbor("plain", 0.7) }, neighbor("below", 0.59)], profile);
  assert.equal(ranked[0].product_id, "personal"); assert.equal(ranked.length, 2);
});

test("A matching photo returns ranked neighbours with its detected category and no featured rows", async () => {
  const f = fixture();
  f.setNeighbors([neighbor("a", 0.82, "ao"), neighbor("b", 0.71, "ao"), neighbor("c", 0.65, "dam-vay")]);
  f.setFeatured([neighbor("featured", 0, "ao")]);
  const result = await f.service.search("guest:a", randomUUID(), Buffer.from("source"), "image/png", { min_price: 100 });
  assert.deepEqual(result.matches.map(row => row.product_id), ["a", "b", "c"]);
  assert.equal(result.attributes.category, "ao");
  assert.deepEqual(result.featured, []);
  assert.equal(result.catalog_version, "1");
  assert.deepEqual(f.counters().lastFilters, { min_price: 100 });
});

test("Neighbours below the match threshold fall back to featured rows of the detected category", async () => {
  const f = fixture();
  f.setNeighbors([neighbor("near", 0.55, "dam-vay"), neighbor("nearer", 0.52, "dam-vay")]);
  f.setFeatured([neighbor("featured", 0, "dam-vay")]);
  const result = await f.service.search("guest:a", randomUUID(), Buffer.from("source"), "image/png", {});
  assert.deepEqual(result.matches, []);
  assert.equal(result.attributes.category, "dam-vay");
  assert.deepEqual(result.featured.map(row => row.product_id), ["featured"]);
});

test("A photo with no catalog neighbour is rejected instead of pretending to match", async () => {
  const f = fixture();
  f.setNeighbors([neighbor("far", 0.4, "ao")]);
  const bytes = Buffer.from("source");
  await assert.rejects(f.service.search("guest:a", randomUUID(), bytes, "image/png", {}), { code: "NOT_A_GARMENT" });
  assert.ok(bytes.every(value => value === 0));
  assert.equal(f.counters().searchCalls, 1);
  // An empty index (no neighbours at all) is a catalog state, not a photo verdict.
  f.setNeighbors([]);
  f.setFeatured([neighbor("featured", 0)]);
  const result = await f.service.search("guest:a", randomUUID(), Buffer.from("source"), "image/png", {});
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.featured.map(row => row.product_id), ["featured"]);
});

test("Source buffers are wiped after success and a provider vector of the wrong namespace is refused", async () => {
  const f = fixture(), bytes = Buffer.from("source-image");
  await f.service.search("guest:a", randomUUID(), bytes, "image/png", {});
  assert.ok(bytes.every(value => value === 0));
  const wrong = fixture({ async embedImage() { return Array.from({ length: 1536 }, () => 0.5); } });
  const wrongBytes = Buffer.from("source");
  await assert.rejects(wrong.service.search("guest:a", randomUUID(), wrongBytes, "image/png", {}), { code: "VISUAL_VECTOR_INVALID" });
  assert.ok(wrongBytes.every(value => value === 0));
});

test("Body filtering requires a member and completed profile before the catalog is queried", async () => {
  const guest = fixture();
  await assert.rejects(guest.service.search("guest:a", randomUUID(), Buffer.from("source"), "image/png", { body_shape: "Pear" }), { code: "BODY_FILTER_MEMBER_REQUIRED" });
  const member = fixture();
  await assert.rejects(member.service.search("member:a", randomUUID(), Buffer.from("source"), "image/png", { body_shape: "Pear" }, "user-a"), { code: "BODY_FILTER_QUIZ_REQUIRED" });
  assert.equal(member.counters().searchCalls, 0);
});

test("Total deadline covers provider stalls and at most two retries", async () => {
  let attempts = 0;
  const failed = fixture({ async embedImage() { attempts++; throw new HttpError(503, "PROVIDER_UNAVAILABLE", "unavailable"); } });
  const bytes = Buffer.from("source");
  await assert.rejects(failed.service.search("guest:a", randomUUID(), bytes, "image/png", {}), { code: "PROVIDER_UNAVAILABLE" });
  assert.equal(attempts, 3); assert.ok(bytes.every(value => value === 0));
  const stalled = fixture({ embedImage: () => new Promise(() => undefined) }, null, 100);
  const stalledBytes = Buffer.from("source");
  await assert.rejects(stalled.service.search("guest:a", randomUUID(), stalledBytes, "image/png", {}), { code: "VISUAL_SEARCH_TIMEOUT" });
  assert.ok(stalledBytes.every(value => value === 0));
});

test("Cancellation is owner-bound, handles pre-arrival cancellation and wipes buffers", async () => {
  let reached!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const f = fixture({ async embedImage() { reached(); return new Promise(() => undefined); } });
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

test("Multipart source bytes never remain in request chunks after parsing/release", async () => {
  const body = Buffer.from('--b\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nsource\r\n--b\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{"consent":true}\r\n--b--\r\n');
  const upload = await readVisualUpload({ headers: { "content-type": "multipart/form-data; boundary=b" }, async *[Symbol.asyncIterator]() { yield body; } });
  assert.ok(body.every(value => value === 0)); assert.equal(upload.bytes.toString(), "source");
  upload.release(); assert.ok(upload.bytes.every(value => value === 0));
});
