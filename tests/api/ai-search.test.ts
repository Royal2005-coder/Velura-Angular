import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HttpError } from "../../apps/api/src/http.js";
import { AiSearchService, type AiSearchProviders } from "../../apps/api/src/ai-search/ai-search-service.js";
import type { AiSearchRepository } from "../../apps/api/src/ai-search/ai-search-types.js";
import { fashionQuery, validateSearchText, MAX_QUERY_CHARS } from "../../apps/api/src/ai-search/ai-search-text.js";
import { composedQueryVector } from "../../apps/api/src/ai/image-vector-repository.js";
import type { VisualCandidate } from "../../apps/api/src/visual-search/visual-search-types.js";

const clipVector = Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0);
function neighbor(product_id: string, similarity: number, category_slug?: string, scores?: { em_score: number; is_score: number }): VisualCandidate {
  return { product_id, similarity, status: "on_sale", category_slug, ...scores };
}
function fixture(overrides: Partial<AiSearchProviders> = {}, profile: Record<string, unknown> | null = null, timeout = 15000) {
  let embedTextCalls = 0, embedImageCalls = 0, searchCalls = 0, composedCalls = 0;
  let lastFilters: unknown, lastText = "";
  let neighbors: VisualCandidate[] = [neighbor("match", 0.32, "dam-vay")];
  let featured: VisualCandidate[] = [];
  const repo: AiSearchRepository = {
    async profile() { return profile; },
    async imageSearch(_vector, filters) { searchCalls++; lastFilters = filters; return { neighbors, featured, catalog_version: "1" }; },
    async composedSearch(_reference, _modifier, filters) { composedCalls++; lastFilters = filters; return { neighbors, featured, catalog_version: "1" }; },
  };
  const providers: AiSearchProviders = {
    async decode(bytes) { return { bytes: Buffer.from(bytes), mime: "image/png" }; },
    async embedImage() { embedImageCalls++; return clipVector; },
    async embedText(text) { embedTextCalls++; lastText = text; return clipVector; },
    ...overrides,
  };
  const service = new AiSearchService(repo, providers, timeout);
  return { service, setNeighbors(rows: VisualCandidate[]) { neighbors = rows; }, setFeatured(rows: VisualCandidate[]) { featured = rows; }, counters: () => ({ embedTextCalls, embedImageCalls, searchCalls, composedCalls, lastFilters, lastText }) };
}

test("Search text validation bounds one utterance and rejects control/punctuation-only input", () => {
  assert.equal(validateSearchText("  đầm   đỏ ", "query"), "đầm đỏ");
  assert.equal(validateSearchText("màu đỏ, dáng xòe", "modifier"), "màu đỏ, dáng xòe");
  for (const bad of ["", "   ", "!!!", "x".repeat(MAX_QUERY_CHARS + 1), "đầm\u0000đỏ", 42, null]) {
    assert.throws(() => validateSearchText(bad, "query"), { status: 422, code: "AI_SEARCH_TEXT_INVALID" });
  }
});

test("The fashion lexicon maps longest phrases first and never corrupts brand or English words", () => {
  assert.equal(fashionQuery("Đầm đỏ dáng xòe"), "dress red dáng flared");
  assert.equal(fashionQuery("áo khoác denim xanh navy"), "jacket denim navy");
  assert.equal(fashionQuery("màu be"), "beige");
  assert.equal(fashionQuery("sandals da thật"), "sandals leather thật");
  assert.equal(fashionQuery("red floral dress"), "red floral dress");
  assert.equal(fashionQuery("tìm mua"), "");
  assert.ok(fashionQuery("quần jean ống rộng").startsWith("jeans"));
});

test("Composed query is the unit normalize(reference+modifier), i.e. the equal-weight EM+IS ranking", () => {
  const reference = Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0);
  const modifier = Array.from({ length: 512 }, (_, i) => i === 1 ? 1 : 0);
  const composed = composedQueryVector(reference, modifier);
  const norm = Math.sqrt(composed.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);
  assert.ok(Math.abs(composed[0] - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(composed[1] - Math.SQRT1_2) < 1e-9);
  const target = Array.from({ length: 512 }, (_, i) => i === 0 ? 0.8 : i === 1 ? 0.6 : 0);
  const em = modifier.reduce((sum, value, i) => sum + value * target[i], 0);
  const is = reference.reduce((sum, value, i) => sum + value * target[i], 0);
  const score = composed.reduce((sum, value, i) => sum + value * target[i], 0);
  assert.ok(Math.abs(score * Math.sqrt(2) - (em + is)) < 1e-9);
});

test("Text search encodes the mapped query and ranks in the shared image namespace", async () => {
  const f = fixture();
  f.setNeighbors([neighbor("a", 0.35, "dam-vay"), neighbor("b", 0.25, "dam-vay"), neighbor("c", 0.21, "ao")]);
  f.setFeatured([neighbor("featured", 0, "dam-vay")]);
  const result = await f.service.textSearch("guest:a", randomUUID(), "đầm đỏ", { min_price: 100 });
  assert.equal(result.mode, "text");
  assert.equal(result.query_text, "dress red");
  assert.deepEqual(result.matches.map(row => row.product_id), ["a", "b"]);
  assert.equal(result.matches[0].tier, "strong");
  assert.equal(result.matches[1].tier, "similar");
  assert.equal(result.attributes.category, "dam-vay");
  assert.deepEqual(result.featured, []);
  assert.equal(result.fallback, null);
  assert.deepEqual(f.counters().lastFilters, { min_price: 100 });
  assert.equal(f.counters().lastText, "dress red");
  assert.equal(f.counters().composedCalls, 0);
});

test("Text neighbours below the floor fall back to the voted catalog rail", async () => {
  const f = fixture();
  f.setNeighbors([neighbor("near", 0.19, "ao"), neighbor("nearer", 0.18, "ao")]);
  f.setFeatured([neighbor("featured", 0, "ao")]);
  const result = await f.service.textSearch("guest:a", randomUUID(), "áo sơ mi trắng", {});
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.featured.map(row => row.product_id), ["featured"]);
  assert.deepEqual(result.fallback, { category: "ao", category_name: "Áo", color_tone: null, color_name: null });
});

test("A stopword-only query is rejected before any inference", async () => {
  const f = fixture();
  await assert.rejects(f.service.textSearch("guest:a", randomUUID(), "tìm mua", {}), { status: 422, code: "AI_SEARCH_TEXT_INVALID" });
  assert.equal(f.counters().embedTextCalls, 0);
  assert.equal(f.counters().searchCalls, 0);
});

test("Composed search keeps EM/IS components and ranks by the composed cosine", async () => {
  const f = fixture();
  f.setNeighbors([
    neighbor("a", 0.65, "dam-vay", { em_score: 0.3, is_score: 0.8 }),
    neighbor("b", 0.5, "dam-vay", { em_score: 0.4, is_score: 0.5 }),
    neighbor("c", 0.3, "ao", { em_score: 0.5, is_score: 0.31 }),
  ]);
  const bytes = Buffer.from("source");
  const result = await f.service.composedSearch("guest:a", randomUUID(), bytes, "image/png", "màu đỏ", {});
  assert.equal(result.mode, "composed");
  assert.equal(result.query_text, "red");
  assert.deepEqual(result.matches.map(row => row.product_id), ["a", "b"]);
  assert.equal(result.matches[0].tier, "strong");
  assert.equal(result.matches[0].em_score, 0.3);
  assert.equal(result.matches[0].is_score, 0.8);
  assert.equal(result.matches[1].tier, "similar");
  assert.ok(bytes.every(value => value === 0));
  assert.equal(f.counters().embedImageCalls, 1);
  assert.equal(f.counters().embedTextCalls, 1);
  assert.equal(f.counters().composedCalls, 1);
});

test("The garment verdict uses the IS component, so a strong text match cannot rescue a detail-free photo", async () => {
  const f = fixture();
  f.setNeighbors([neighbor("far", 0.55, "ao", { em_score: 0.6, is_score: 0.2 })]);
  const bytes = Buffer.from("source");
  await assert.rejects(f.service.composedSearch("guest:a", randomUUID(), bytes, "image/png", "đỏ", {}), { status: 422, code: "NOT_A_GARMENT" });
  assert.ok(bytes.every(value => value === 0));
  f.setNeighbors([]);
  f.setFeatured([neighbor("featured", 0)]);
  const empty = await f.service.composedSearch("guest:a", randomUUID(), Buffer.from("source"), "image/png", "đỏ", {});
  assert.deepEqual(empty.matches, []);
  assert.deepEqual(empty.featured.map(row => row.product_id), ["featured"]);
});

test("Wrong-namespace vectors are refused on both towers and source bytes are wiped", async () => {
  const wrongText = fixture({ async embedText() { return Array.from({ length: 1536 }, () => 0.5); } });
  await assert.rejects(wrongText.service.textSearch("guest:a", randomUUID(), "đầm", {}), { code: "AI_SEARCH_VECTOR_INVALID" });
  const wrongImage = fixture({ async embedImage() { return Array.from({ length: 1536 }, () => 0.5); } });
  const bytes = Buffer.from("source");
  await assert.rejects(wrongImage.service.composedSearch("guest:a", randomUUID(), bytes, "image/png", "đỏ", {}), { code: "AI_SEARCH_VECTOR_INVALID" });
  assert.ok(bytes.every(value => value === 0));
});

test("Body filtering requires a member and completed profile before the catalog is queried", async () => {
  const guest = fixture();
  await assert.rejects(guest.service.textSearch("guest:a", randomUUID(), "đầm", { body_shape: "Pear" }), { code: "BODY_FILTER_MEMBER_REQUIRED" });
  const member = fixture();
  await assert.rejects(member.service.composedSearch("member:a", randomUUID(), Buffer.from("source"), "image/png", "đỏ", { body_shape: "Pear" }, "user-a"), { code: "BODY_FILTER_QUIZ_REQUIRED" });
  assert.equal(member.counters().composedCalls, 0);
});

test("Total deadline covers text-encoder stalls and at most two retries", async () => {
  let attempts = 0;
  const failed = fixture({ async embedText() { attempts++; throw new HttpError(503, "PROVIDER_UNAVAILABLE", "unavailable"); } });
  await assert.rejects(failed.service.textSearch("guest:a", randomUUID(), "đầm", {}), { code: "PROVIDER_UNAVAILABLE" });
  assert.equal(attempts, 3);
  const stalled = fixture({ embedText: () => new Promise(() => undefined) }, null, 100);
  await assert.rejects(stalled.service.textSearch("guest:a", randomUUID(), "đầm", {}), { code: "AI_SEARCH_TIMEOUT" });
});

test("Cancellation is owner-bound, handles pre-arrival cancellation and wipes buffers", async () => {
  let reached!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const f = fixture({ async embedText() { reached(); return new Promise(() => undefined); } });
  const id = randomUUID();
  const pending = f.service.textSearch("guest:a", id, "đầm", {});
  await waiting; f.service.cancel("guest:b", id); f.service.cancel("guest:a", id);
  await assert.rejects(pending, { code: "AI_SEARCH_CANCELLED" });
  const early = randomUUID(); f.service.cancel("guest:a", early);
  const bytes = Buffer.from("source");
  await assert.rejects(f.service.composedSearch("guest:a", early, bytes, "image/png", "đỏ", {}), { code: "AI_SEARCH_CANCELLED" });
  assert.ok(bytes.every(value => value === 0));
});

test("Session rate limit counts failures and does not block unrelated sessions", () => {
  const f = fixture(); for (let i = 0; i < 15; i++) f.service.consume("guest:a");
  assert.throws(() => f.service.consume("guest:a"), { code: "AI_SEARCH_RATE_LIMIT" });
  assert.doesNotThrow(() => f.service.consume("guest:b"));
});