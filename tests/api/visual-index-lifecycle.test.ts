import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalImageVectorRepository } from "../../apps/api/src/ai/image-vector-repository.js";
import { CatalogIndexLifecycle } from "../../apps/api/src/ai/catalog-index-lifecycle.js";
import { AiService, type AiCatalog } from "../../apps/api/src/ai/ai-service.js";
import { LocalAiRepository } from "../../apps/api/src/ai/ai-repository.js";
import { VisualSearchService } from "../../apps/api/src/visual-search/visual-search-service.js";
import type { AiWorker } from "../../apps/api/src/ai/ai-types.js";

const vector = Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0);
const product = "12345678-1234-4234-8234-123456789012";
const other = "12345678-1234-4234-8234-123456789013";
const metadata = { product_id: product, model: "openclip-vit-b32-laion2b" as const, image_revision: "revision1" };

test("Missing/corrupt/empty/incompatible/unreadable index is 503; only absent storage permits bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "visual-index-readiness-"));
  const file = join(root, "catalog-image-vectors.json");
  const vectors = new LocalImageVectorRepository(root);
  try {
    await assert.rejects(() => vectors.search(vector), { status: 503, code: "VISUAL_INDEX_UNAVAILABLE" });
    assert.equal((await vectors.revisions()).size, 0);
    await vectors.upsert({ ...metadata, embedding: vector });
    assert.equal((await vectors.search(vector)).length, 1);
    assert.deepEqual(await vectors.search(vector, { product_ids: [] }), []);
    for (const raw of ["{broken", "[]", "null", "{}", JSON.stringify([{ ...metadata, embedding: Array(1536).fill(1) }]), JSON.stringify([{ ...metadata, model: "text-model", embedding: vector }])]) {
      await writeFile(file, raw);
      await assert.rejects(() => vectors.search(vector), { status: 503, code: "VISUAL_INDEX_UNAVAILABLE" });
      await assert.rejects(() => vectors.version(), { code: "VISUAL_INDEX_UNAVAILABLE" });
      if (raw !== "[]") {
        await assert.rejects(() => vectors.upsert({ ...metadata, embedding: vector }), { code: "VISUAL_INDEX_UNAVAILABLE" });
        assert.equal(await readFile(file, "utf8"), raw);
      }
    }
    await rm(file);
    await mkdir(file);
    await assert.rejects(() => vectors.search(vector), { status: 503, code: "VISUAL_INDEX_UNAVAILABLE" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Search rejects unavailable index before inference, but healthy filtered no-match remains successful", async () => {
  const root = await mkdtemp(join(tmpdir(), "visual-index-query-"));
  const vectors = new LocalImageVectorRepository(root);
  let calls = 0;
  const service = new VisualSearchService({
    assertReady: () => vectors.assertReady(), profile: async () => null,
    async imageSearch(query) { return { neighbors: await vectors.search(query, { product_ids: [] }), featured: [], catalog_version: await vectors.version() }; },
  }, { decode: async bytes => ({ bytes, mime: "image/png" }), embedImage: async () => { calls++; return vector; } });
  try {
    await assert.rejects(() => service.search("guest", "absent", Buffer.from("photo"), "image/png", {}), { status: 503, code: "VISUAL_INDEX_UNAVAILABLE" });
    assert.equal(calls, 0);
    await vectors.upsert({ ...metadata, embedding: vector });
    const result = await service.search("guest", "healthy", Buffer.from("photo"), "image/png", {});
    assert.deepEqual(result.matches, []);
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Runtime backfills actual catalog-only queue jobs, reconciles revisions, skips bad images, and never overlaps", async t => {
  process.env.NODE_ENV = "test";
  process.env.AI_VERIFIED_TASKS = "image_embedding";
  const root = await mkdtemp(join(tmpdir(), "visual-index-runtime-"));
  const vectors = new LocalImageVectorRepository(root);
  let revision = "revision1", ready = false, runs = 0, concurrent = 0, maximum = 0, images = 0, clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const catalog: AiCatalog = {
    garment: async () => { throw new Error("not garment"); }, studio: async () => { throw new Error("not studio"); }, searchable: async () => true,
    async image(id) {
      images++;
      if (id === other) throw new Error("broken photo");
      return { bytes: Buffer.from("real-catalog-fixture"), metadata: { ...metadata, image_revision: revision } };
    },
  };
  const worker: AiWorker = {
    ready: () => ready,
    async refreshReadiness() {},
    async run(directory) {
      concurrent++; maximum = Math.max(maximum, concurrent); runs++;
      const payload = JSON.parse(await readFile(join(directory, "job.json"), "utf8")) as { images: string[] };
      concurrent--;
      return { status: "success", model: metadata.model, dimensions: 512, batch_embeddings: payload.images.map(image => ({ image, embedding: vector })) };
    },
  };
  const repo = new LocalAiRepository(root);
  let terminal = Promise.withResolvers<void>();
  const transition = repo.transition.bind(repo);
  t.mock.method(repo, "transition", async (...args: Parameters<typeof repo.transition>) => {
    const updated = await transition(...args);
    if (["success", "failed", "cancelled"].includes(String(args[2].status))) terminal.resolve();
    return updated;
  });
  const service = new AiService(repo, worker, catalog, vectors);
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let block = false, lists = 0;
  const source = { async published(after: string, limit: number) {
    assert.equal(limit, 4); lists++;
    if (block) { entered.resolve(); await gate.promise; }
    return [{ ...metadata, image_revision: revision }, { product_id: other, image_revision: "bad1" }].filter(row => row.product_id > after);
  } };
  const lifecycle = new CatalogIndexLifecycle(service, source, vectors);
  async function settle() {
    await terminal.promise;
    await lifecycle.tick();
    terminal = Promise.withResolvers<void>();
    assert.equal(lifecycle.status().syncing, false);
  }
  try {
    await service.recover();
    await lifecycle.tick();
    assert.equal(lists, 0);
    assert.equal(runs, 0);
    assert.equal(lifecycle.status().error, "AI_ENGINE_UNAVAILABLE");
    ready = true; clock += 15_001; block = true;
    const first = lifecycle.tick();
    await entered.promise;
    assert.equal(lifecycle.tick(), first);
    gate.resolve(); block = false;
    await first; await settle(); await lifecycle.tick();
    assert.equal((await vectors.revisions()).get(product), "revision1");
    assert.equal(lifecycle.status().coverage?.published, 2);
    assert.equal(lifecycle.status().coverage?.indexed, 1);
    assert.equal(lifecycle.status().coverage?.skipped, 1);
    assert.equal(runs, 1); assert.equal(images, 2); assert.equal(maximum, 1);
    clock += 60_001;
    await lifecycle.tick(); await lifecycle.tick();
    assert.equal(runs, 1); assert.equal(images, 2);
    revision = "revision2"; clock += 60_001;
    await lifecycle.tick(); await settle(); await lifecycle.tick();
    assert.equal((await vectors.revisions()).get(product), "revision2");
    assert.equal(runs, 2); assert.equal(images, 3); assert.equal(maximum, 1);
    await lifecycle.close();
    clock += 60_001; await lifecycle.tick();
    assert.equal(runs, 2);
  } finally { await lifecycle.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("Byte-safe discovery advances its cursor through four-product pages and completes coverage", async () => {
  process.env.NODE_ENV = "test";
  process.env.AI_VERIFIED_TASKS = "image_embedding";
  const root = await mkdtemp(join(tmpdir(), "visual-index-pages-"));
  const vectors = new LocalImageVectorRepository(root);
  const rows = Array.from({ length: 9 }, (_, i) => ({ ...metadata, product_id: `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`, embedding: vector }));
  const service = new AiService(new LocalAiRepository(root), {
    ready: () => true,
    async run() { throw new Error("fresh rows must not enqueue inference"); },
  }, {
    async garment() { throw new Error("not a garment job"); },
    async studio() { throw new Error("not a studio job"); },
    async searchable() { return true; },
    async image() { throw new Error("fresh catalog revisions must not download images"); },
  }, vectors);
  const cursors: string[] = [], sizes: number[] = [];
  const lifecycle = new CatalogIndexLifecycle(service, {
    async published(after, limit) {
      assert.equal(limit, 4);
      cursors.push(after);
      const page = rows.filter(row => row.product_id > after).slice(0, limit);
      sizes.push(page.length);
      return page;
    },
  }, vectors);
  try {
    await vectors.upsertBatch(rows);
    for (let i = 0; i < 4; i++) await lifecycle.tick();
    assert.deepEqual(cursors, ["", rows[3].product_id, rows[7].product_id, rows[8].product_id]);
    assert.deepEqual(sizes, [4, 4, 1, 0]);
    assert.equal(lifecycle.status().coverage?.published, 9);
    assert.equal(lifecycle.status().coverage?.indexed, 9);
    assert.equal(lifecycle.status().coverage?.skipped, 0);
    assert.equal(lifecycle.status().error, null);
  } finally { await lifecycle.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
