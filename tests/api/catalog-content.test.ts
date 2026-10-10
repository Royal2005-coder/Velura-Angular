import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../apps/api/src/http.js";
import type { AuthContext, JsonObject } from "../../apps/api/src/types.js";
import { CatalogContentService } from "../../apps/api/src/catalog-content/catalog-content-service.js";
import type { CatalogContent, CatalogContentRepository, CatalogDraft, CatalogSource, GroundedClaim } from "../../apps/api/src/catalog-content/catalog-content-types.js";
import { catalogPrompt, validateCatalogContent } from "../../apps/api/src/catalog-content/catalog-content-validation.js";

const productId = "30000000-0000-4000-8000-000000000001";
const actorId = "30000000-0000-4000-8000-000000000002";
const draftId = "30000000-0000-4000-8000-000000000003";
const source: CatalogSource = { productId, version: 1, revision: "verified-revision", fields: { name: "Áo Velura", category: "Áo", "variants.one.color": "Trắng", "tags.1": "Công sở" }, photos: ["https://example.com/catalog.jpg"] };
const claim = (text = "Áo Velura", field = "name"): GroundedClaim => ({ text, sources: [{ field, quote: text }] });
function content(): CatalogContent {
  return { title: claim(), short: claim(), long: claim(), highlights: [], styling: [], care: [], seoTitle: claim(), metaDescription: claim(), proposedSlug: "ao-velura", primaryKeywords: [claim()], secondaryKeywords: [claim("Áo", "category")], alt: [{ photo: source.photos[0], claim: claim() }], tags: [claim("Công sở", "tags.1")] };
}
const context: AuthContext = { authUser: { id: actorId }, profile: { user_id: actorId, role: "admin", is_active: true }, roleCode: "super_admin", roleName: "Admin", isAdmin: true, allowedPages: ["products"], allowedModules: ["products"], accessToken: "test" };
function draft(): CatalogDraft { return { id: draftId, product_id: productId, source: structuredClone(source), generated: content(), reviewed: null, status: "draft", version: 1, metadata: { model: "test", schema: "test", prompt: "test", sourceRevision: source.revision }, created_at: "" }; }
class RecordingRepository implements CatalogContentRepository {
  calls: { actor: string | null; action: string; payload: JsonObject }[] = [];
  handler: (action: string, payload: JsonObject) => unknown = () => null;
  async execute<T>(actor: string | null, action: string, payload: JsonObject = {}): Promise<T> {
    this.calls.push({ actor, action, payload });
    return this.handler(action, payload) as T;
  }
}

test("missing material and care stay unknown, while exact catalog name remains usable", () => {
  const validated = validateCatalogContent(content(), source);
  assert.deepEqual(validated.care, []);
  assert.equal(validated.title.text, "Áo Velura");
  const invalid = content(); invalid.highlights = [claim("Cotton", "material")];
  assert.throws(() => validateCatalogContent(invalid, source));
});
test("self-reported grounding cannot smuggle origin or property into a cited claim", () => {
  for (const text of ["Áo Velura cotton", "Áo Velura made in Italy", "Áo Velura chống nắng"]) {
    const invalid = content(); invalid.long = { text, sources: [{ field: "name", quote: "Áo Velura" }] };
    assert.throws(() => validateCatalogContent(invalid, source));
  }
});
test("styling and care require independently verified care/styling fields", () => {
  const invalid = content(); invalid.care = [claim()];
  assert.throws(() => validateCatalogContent(invalid, source));
  const verified = { ...source, fields: { ...source.fields, "care.1": "Giặt tay" } };
  invalid.care = [claim("Giặt tay", "care.1")];
  assert.equal(validateCatalogContent(invalid, verified).care[0].text, "Giặt tay");
});
test("missing SEO, unknown fields, script markup, oversized values and mismatched slug are invalid", () => {
  const oversized = { ...source, fields: { ...source.fields, "features.1": "A".repeat(61) } };
  const cases: unknown[] = [{ ...content(), seoTitle: claim("") }, { ...content(), price: 5 }, { ...content(), sku: "NEW" }, { ...content(), stock: 10 }, { ...content(), proposedSlug: "invented-slug" }, { ...content(), seoTitle: claim("<script>") }];
  for (const value of cases) assert.throws(() => validateCatalogContent(value, source));
  assert.throws(() => validateCatalogContent({ ...content(), seoTitle: claim("A".repeat(61), "features.1") }, oversized));
});
test("duplicate keywords, unconfirmed tags and unrelated image alt are rejected", () => {
  const keyword = content(); keyword.secondaryKeywords = [claim()];
  assert.throws(() => validateCatalogContent(keyword, source));
  const tags = content(); tags.tags = [claim()];
  assert.throws(() => validateCatalogContent(tags, source));
  const image = content(); image.alt[0].photo = "https://example.com/other.jpg";
  assert.throws(() => validateCatalogContent(image, source));
});
test("invalid output records finite failure without saving or replacing prior content", async () => {
  const repository = new RecordingRepository();
  repository.handler = action => action === "claim" ? { id: draftId, actor_id: actorId, lease: "lease", source } : null;
  for (const output of ["not-json", JSON.stringify({ ...content(), title: claim("Invented") })]) {
    repository.calls = [];
    await new CatalogContentService(repository, async () => output, "test").workOne();
    assert.deepEqual(repository.calls.map(c => c.action), ["claim", "fail"]);
    assert.equal(repository.calls[1].payload.error, "CONTENT_INVALID");
  }
});
test("provider failure is finite and does not expose provider text in item errors", async () => {
  const repository = new RecordingRepository();
  repository.handler = action => action === "claim" ? { id: draftId, actor_id: actorId, lease: "lease", source } : null;
  await new CatalogContentService(repository, async () => { throw new Error("provider-secret"); }, "test").workOne();
  assert.equal(repository.calls[1].payload.error, "GENERATION_FAILED");
  assert.ok(!JSON.stringify(repository.calls).includes("provider-secret"));
});
test("invalid review never persists and expectedVersion is mandatory", async () => {
  const repository = new RecordingRepository(); repository.handler = () => draft();
  const service = new CatalogContentService(repository);
  await assert.rejects(service.review(context, draftId, { expectedVersion: 1, decision: "approve", content: { ...content(), origin: "Italy" } }));
  assert.ok(repository.calls.every(c => c.action !== "review"));
  await assert.rejects(service.review(context, draftId, { decision: "approve", content: content() }));
});
test("unauthenticated, viewer, inactive and unrelated admin cannot generate or publish", async () => {
  const repository = new RecordingRepository(), service = new CatalogContentService(repository);
  const blocked = [undefined, { ...context, roleCode: "admin_viewer" }, { ...context, profile: { ...context.profile!, is_active: false } }, { ...context, roleCode: "admin_operator_donhang" }];
  for (const actor of blocked) {
    await assert.rejects(service.enqueue(actor, { products: [{ productId, expectedVersion: 1 }], idempotencyKey: "security-key" }));
    assert.throws(() => service.publish(actor, draftId, { expectedVersion: 1, expectedDraftVersion: 1 }));
  }
  assert.equal(repository.calls.length, 0);
});
test("bulk bounds, duplicate products and generated commercial input are rejected before queue access", async () => {
  const repository = new RecordingRepository(), service = new CatalogContentService(repository);
  for (const products of [[], Array.from({ length: 51 }, () => ({ productId, expectedVersion: 1 })), [{ productId, expectedVersion: 1 }, { productId, expectedVersion: 1 }], [{ productId, expectedVersion: 1, sku: "generated" }]]) {
    await assert.rejects(service.enqueue(context, { products, idempotencyKey: "bounded-key" }));
  }
  assert.equal(repository.calls.length, 0);
});
