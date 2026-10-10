import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiService, type AiCatalog } from "../../apps/api/src/ai/ai-service.js";
import { LocalAiRepository } from "../../apps/api/src/ai/ai-repository.js";
import {
  LocalImageVectorRepository,
  normalizedImageVector,
} from "../../apps/api/src/ai/image-vector-repository.js";
import type {
  AiWorker,
  AiWorkerResult,
} from "../../apps/api/src/ai/ai-types.js";
import { aiOwner } from "../../apps/api/src/ai/ai-router.js";
import { ShopAiCatalog } from "../../apps/api/src/ai/ai-catalog.js";
import type { AuthContext } from "../../apps/api/src/types.js";

const PNG = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#ffffff" } }).png().toBuffer();
const vector = Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
const product = "12345678-1234-4234-8234-123456789012";
test("Catalog candidates are applied before visual top-match truncation, including an empty filter result", async () => {
  const root = await mkdtemp(join(tmpdir(), "visual-filter-"));
  try {
    const repository = new LocalImageVectorRepository(root);
    const rows = Array.from({ length: 30 }, (_, i) => ({
      product_id: `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`,
      model: "openclip-vit-b32-laion2b" as const,
      image_revision: "revision1",
      embedding: vector,
    }));
    await repository.upsertBatch(rows);
    const target = rows[29].product_id;
    assert.equal(
      (await repository.search(vector)).some(
        (row) => row.product_id === target,
      ),
      false,
    );
    assert.deepEqual(
      (await repository.search(vector, { product_ids: [target] })).map(
        (row) => row.product_id,
      ),
      [target],
    );
    assert.deepEqual(await repository.search(vector, { product_ids: [] }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
const catalog: AiCatalog = {
  async garment() {
    return { bytes: PNG, category: "upper_body" };
  },
  async studio() {
    return PNG;
  },
  async searchable() {
    return true;
  },
  async image(id) {
    return {
      bytes: PNG,
      metadata: {
        product_id: id,
        model: "openclip-vit-b32-laion2b",
        image_revision: "revision1",
        category_id: "shirts",
        style_tags: ["minimal"],
      },
    };
  },
};
async function setup(worker: AiWorker, source: AiCatalog = catalog) {
  process.env.NODE_ENV = "test";
  process.env.AI_VERIFIED_TASKS =
    "image_quality,image_embedding,virtual_try_on,product_image_enhance";
  const root = await mkdtemp(join(tmpdir(), "velura-ai-"));
  const repo = new LocalAiRepository(root);
  const service = new AiService(repo, worker, source);
  return {
    root,
    repo,
    service,
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function terminal(service: AiService, owner: string, id: string) {
  for (let i = 0; i < 2000; i++) {
    const job = await service.get(owner, id);
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("TEST_JOB_TIMEOUT");
}
const worker: AiWorker = {
  ready: () => true,
  async run() {
    return { status: "success", gate: { valid: true, reasons: [] } };
  },
};

test("AI capabilities fail closed in production and for unverified tasks", async () => {
  const fixture = await setup(worker);
  try {
    process.env.AI_VERIFIED_TASKS = "image_quality";
    assert.equal(
      fixture.service
        .capabilities()
        .tasks.find((t) => t.task === "virtual_try_on")?.enabled,
      false,
    );
    process.env.NODE_ENV = "production";
    assert.equal(fixture.service.capabilities().enabled, false);
    await assert.rejects(
      () => fixture.service.upload("owner", PNG, "image/png"),
      { code: "AI_ENGINE_UNAVAILABLE" },
    );
  } finally {
    await fixture.close();
    process.env.NODE_ENV = "test";
  }
});
test("Private assets reject another principal, spoofed MIME, missing consent and admin-only editing", async () => {
  const fixture = await setup(worker);
  try {
    await assert.rejects(() => fixture.service.upload("a", PNG, "image/jpeg"), {
      code: "INVALID_IMAGE",
    });
    const asset = await fixture.service.upload("a", PNG, "image/png");
    const body = {
      task: "image_quality",
      image_asset_id: asset.asset_id,
      consent: true,
      confirmed: true,
      idempotency_key: "private-key-123",
    };
    await assert.rejects(() => fixture.service.create("b", body), {
      code: "ASSET_NOT_FOUND",
    });
    await assert.rejects(
      () => fixture.service.create("a", { ...body, consent: false }),
      { code: "CONSENT_REQUIRED" },
    );
    await assert.rejects(
      () =>
        fixture.service.create("a", { ...body, task: "product_image_enhance" }),
      { code: "RBAC_DENIED" },
    );
    const job = await fixture.service.create("a", body);
    await terminal(fixture.service, "a", job.id);
    await assert.rejects(() => fixture.service.get("b", job.id), {
      code: "JOB_NOT_FOUND",
    });
  } finally {
    await fixture.close();
  }
});
test("Concurrent duplicate jobs reuse UUID; changed input under same key conflicts", async () => {
  const fixture = await setup(worker);
  try {
    const asset = await fixture.service.upload("a", PNG, "image/png");
    const body = {
      task: "image_quality",
      image_asset_id: asset.asset_id,
      consent: true,
      confirmed: true,
      idempotency_key: "duplicate-key-123",
    };
    const [first, second] = await Promise.all([
      fixture.service.create("a", body),
      fixture.service.create("a", body),
    ]);
    assert.equal(first.id, second.id);
    assert.equal((await fixture.repo.jobs()).length, 1);
    assert.equal(
      (await fixture.service.getByKey("a", "duplicate-key-123")).id,
      first.id,
    );
    await assert.rejects(
      () => fixture.service.getByKey("b", "duplicate-key-123"),
      { code: "JOB_NOT_FOUND" },
    );
    await assert.rejects(
      () => fixture.service.create("a", { ...body, person_check: true }),
      { code: "IDEMPOTENCY_CONFLICT" },
    );
    await terminal(fixture.service, "a", first.id);
  } finally {
    await fixture.close();
  }
});
test("Late successful worker result cannot undo cancellation or expose an image", async () => {
  let finish: (result: AiWorkerResult) => void = () => undefined;
  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fixture = await setup({
    ready: () => true,
    async run(directory) {
      started();
      return new Promise((resolve) => {
        finish = async (result) => {
          await writeFile(join(directory, "result.png"), PNG);
          resolve(result);
        };
      });
    },
  });
  try {
    const asset = await fixture.service.upload("a", PNG, "image/png");
    const job = await fixture.service.create("a", {
      task: "image_quality",
      image_asset_id: asset.asset_id,
      consent: true,
      confirmed: true,
      idempotency_key: "cancel-key-123",
    });
    await active;
    await fixture.service.cancel("a", job.id);
    finish({ status: "success", result_file: "result.png" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await fixture.service.get("a", job.id)).status, "cancelled");
    await assert.rejects(() => fixture.service.result("a", job.id), {
      code: "RESULT_UNAVAILABLE",
    });
  } finally {
    await fixture.close();
  }
});
test("Expired private asset is inaccessible and maintenance removes source bytes", async () => {
  const fixture = await setup(worker);
  try {
    const asset = await fixture.service.upload("a", PNG, "image/png");
    const stored = (await fixture.repo.asset(asset.asset_id))!;
    stored.expires_at = new Date(Date.now() - 1000).toISOString();
    await fixture.repo.saveAsset(stored, PNG);
    await assert.rejects(
      () =>
        fixture.service.create("a", {
          task: "image_quality",
          image_asset_id: asset.asset_id,
          consent: true,
          confirmed: true,
          idempotency_key: "expired-key-123",
        }),
      { code: "ASSET_NOT_FOUND" },
    );
    await fixture.repo.purge();
    assert.equal(await fixture.repo.asset(asset.asset_id), null);
  } finally {
    await fixture.close();
  }
});
test("Catalog embeddings alone populate CLIP512 index; filters constrain actual matches", async () => {
  const fixture = await setup({
    ready: () => true,
    async run() {
      return {
        status: "success",
        embedding: vector,
        dimensions: 512,
        model: "openclip-vit-b32-laion2b",
      };
    },
  });
  try {
    const indexed = await fixture.service.create(
      "operator",
      {
        task: "image_embedding",
        catalog_index: true,
        product_id: product,
        consent: true,
        confirmed: true,
        idempotency_key: "index-key-123",
      },
      true,
    );
    await terminal(fixture.service, "operator", indexed.id);
    const asset = await fixture.service.upload("guest", PNG, "image/png");
    const search = await fixture.service.create("guest", {
      task: "image_embedding",
      image_asset_id: asset.asset_id,
      consent: true,
      confirmed: true,
      idempotency_key: "search-key-123",
      filters: { category_id: "shirts" },
    });
    const result = await terminal(fixture.service, "guest", search.id);
    assert.deepEqual(result.matches, [{ product_id: product, score: 1 }]);
    const filtered = await fixture.service.create("guest", {
      task: "image_embedding",
      image_asset_id: asset.asset_id,
      consent: true,
      confirmed: true,
      idempotency_key: "search-key-456",
      filters: { category_id: "pants" },
    });
    assert.deepEqual(
      (await terminal(fixture.service, "guest", filtered.id)).matches,
      [],
    );
    const repo = new LocalImageVectorRepository(fixture.root);
    await assert.rejects(
      () =>
        repo.upsert({
          product_id: product,
          model: "openclip-vit-b32-laion2b",
          embedding: Array(1536).fill(1),
          image_revision: "x",
        }),
      { code: "INVALID_IMAGE_VECTOR" },
    );
    assert.throws(() => normalizedImageVector(Array(512).fill(0)), {
      code: "INVALID_IMAGE_VECTOR",
    });
    assert.throws(() => normalizedImageVector(Array(512).fill(1e308)), {
      code: "INVALID_IMAGE_VECTOR",
    });
  } finally {
    await fixture.close();
  }
});
test("Guest ownership requires random browser principal and rejects invalid bearer fallback", () => {
  const context: AuthContext = {
    authUser: null,
    profile: null,
    roleCode: "guest",
    roleName: "Guest",
    isAdmin: false,
    allowedPages: [],
    allowedModules: [],
    accessToken: "",
  };
  assert.throws(
    () => aiOwner({ headers: { "x-guest-session-id": "guessable" } }, context),
    { code: "GUEST_SESSION_REQUIRED" },
  );
  assert.throws(
    () =>
      aiOwner(
        {
          headers: {
            authorization: "Bearer invalid",
            "x-guest-session-id": "gs_12345678-1234-4234-8234-123456789012",
          },
        },
        context,
      ),
    { code: "AUTH_REQUIRED" },
  );
  assert.equal(
    aiOwner(
      {
        headers: {
          "x-guest-session-id": "gs_12345678-1234-4234-8234-123456789012",
        },
      },
      context,
    ),
    "guest:gs_12345678-1234-4234-8234-123456789012",
  );
});
test("Shop garment enforces variant mapping and refuses arbitrary hosts and redirects", async () => {
  const variant = "22222222-2222-4222-8222-222222222222";
  let calls = 0;
  process.env.AI_CATALOG_IMAGE_HOSTS = "images.shop.test";
  const shop = new ShopAiCatalog({
    async product() {
      return { status: "on_sale" };
    },
    async variant() {
      return { variant_id: variant, product_id: product };
    },
    async fetchImage(_url, options) {
      calls++;
      assert.equal(options.redirect, "error");
      throw new Error("Redirect not followed");
    },
  });
  process.env.AI_VTO_PRODUCTS = JSON.stringify({
    [product]: {
      verified: true,
      photo_type: "flat-lay",
      category: "upper_body",
      variant_images: { [variant]: "https://images.shop.test/garment.png" },
    },
  });
  await assert.rejects(
    () => shop.garment(product, "33333333-3333-4333-8333-333333333333"),
    { code: "VTO_VARIANT_UNAVAILABLE" },
  );
  assert.equal(calls, 0);
  process.env.AI_VTO_PRODUCTS = JSON.stringify({
    [product]: {
      category: "upper_body",
      verified: true,
      photo_type: "flat-lay",
      variant_images: { [variant]: "https://attacker.test/garment.png" },
    },
  });
  await assert.rejects(() => shop.garment(product, variant));
  assert.equal(calls, 0);
  process.env.AI_VTO_PRODUCTS = JSON.stringify({
    [product]: {
      category: "upper_body",
      verified: true,
      photo_type: "flat-lay",
      variant_images: { [variant]: "https://images.shop.test/garment.png" },
    },
  });
  await assert.rejects(
    () => shop.garment(product, variant),
    /Redirect not followed/,
  );
  assert.equal(calls, 1);
});
test("A catalog primary photo never enables an unverified or wrong-variant try-on", async () => {
  const variant = "22222222-2222-4222-8222-222222222222";
  const shop = new ShopAiCatalog({
    async product() { return { status: "on_sale", images: ["https://images.shop.test/primary.png"] }; },
    async variant() { return { variant_id: variant, product_id: product }; },
    async fetchImage() { throw new Error("Must reject before download"); },
  });
  process.env.AI_CATALOG_IMAGE_HOSTS = "images.shop.test";
  process.env.AI_VTO_PRODUCTS = JSON.stringify({ [product]: { category: "upper_body" } });
  assert.equal((await shop.support(product, variant)).product_supported, false);
  process.env.AI_VTO_PRODUCTS = JSON.stringify({ [product]: { category: "upper_body", verified: true, photo_type: "flat-lay", variant_images: {} } });
  assert.equal((await shop.support(product, variant)).variant_supported, false);
  await assert.rejects(shop.garment(product, variant), { code: "VTO_VARIANT_UNAVAILABLE" });
});
test("An image signature without a decodable raster is rejected before storage or inference", async () => {
  const fixture = await setup(worker);
  try {
    await assert.rejects(fixture.service.upload("a", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0]), "image/png"), { code: "INVALID_IMAGE" });
  } finally { await fixture.close(); }
});
test("Unsupported try-on products never download garments or queue inference", async () => {
  let runs = 0;
  const fixture = await setup({ ready: () => true, async run() { runs++; return { status: "success" }; } }, {
    ...catalog, async support() { return { product_supported: false, variant_supported: false }; },
    async garment() { throw new Error("Must reject before garment download"); },
  });
  try {
    const asset = await fixture.service.upload("a", PNG, "image/png");
    await assert.rejects(fixture.service.create("a", {
      task: "virtual_try_on", product_id: product, variant_id: "22222222-2222-4222-8222-222222222222",
      mode: "personal", person_asset_id: asset.asset_id, consent: true, confirmed: true, idempotency_key: "unsupported-vto-123",
    }), { code: "VTO_PRODUCT_UNAVAILABLE" });
    assert.equal(runs, 0);
    assert.deepEqual(await fixture.repo.jobs(), []);
  } finally { await fixture.close(); }
});
test("A successful inference with another variant binding cannot expose an image", async () => {
  const fixture = await setup({
    ready: () => true,
    async run(directory) {
      const request = JSON.parse(await readFile(join(directory, "job.json"), "utf8")) as { request_id: string };
      await writeFile(join(directory, "result.png"), PNG);
      return { status: "success", result_file: "result.png", gate: { valid: true },
        binding: { request_id: request.request_id, product_id: product, variant_id: "33333333-3333-4333-8333-333333333333" } };
    },
  }, { ...catalog, async support() { return { product_supported: true, variant_supported: true, garment_category: "upper_body" }; } });
  try {
    const asset = await fixture.service.upload("a", PNG, "image/png");
    const job = await fixture.service.create("a", {
      task: "virtual_try_on", product_id: product, variant_id: "22222222-2222-4222-8222-222222222222",
      mode: "personal", person_asset_id: asset.asset_id, consent: true, confirmed: true, idempotency_key: "variant-bound-vto-123",
    });
    assert.equal((await terminal(fixture.service, "a", job.id)).status, "failed");
    await assert.rejects(fixture.service.result("a", job.id), { code: "RESULT_UNAVAILABLE" });
  } finally { await fixture.close(); }
});
test("Catalog indexing can use a secondary approved shop photo when the primary image is unavailable", async () => {
  process.env.AI_CATALOG_IMAGE_HOSTS = "images.shop.test";
  const requests: string[] = [];
  const shop = new ShopAiCatalog({
    async product() {
      return {
        status: "on_sale",
        images: [
          "https://images.shop.test/broken.png",
          "https://attacker.test/private.png",
          "https://images.shop.test/valid.png",
        ],
      };
    },
    async variant() {
      return null;
    },
    async fetchImage(url) {
      requests.push(url.pathname);
      return url.pathname === "/broken.png"
        ? new Response(null, { status: 404 })
        : new Response(PNG);
    },
  });
  const image = await shop.image(product);
  assert.deepEqual(image.bytes, PNG);
  assert.deepEqual(requests, ["/broken.png", "/valid.png"]);
});
test("Catalog search rejects hidden or stale product image revisions", async () => {
  let status = "on_sale",
    updated = "revision1";
  const shop = new ShopAiCatalog({
    async product() {
      return {
        status,
        images: ["https://images.shop.test/a.png"],
        updated_at: updated,
      };
    },
    async variant() {
      return null;
    },
    async fetchImage() {
      return new Response(PNG);
    },
  });
  process.env.AI_CATALOG_IMAGE_HOSTS = "images.shop.test";
  const indexed = await shop.image(product);
  assert.equal(
    await shop.searchable(product, indexed.metadata.image_revision),
    true,
  );
  updated = "revision2";
  assert.equal(
    await shop.searchable(product, indexed.metadata.image_revision),
    false,
  );
  status = "hidden";
  assert.equal(await shop.searchable(product), false);
});
test("Bounded catalog batch indexes valid rows and reports per-image failures without customer-vector writes", async () => {
  const other = "87654321-4321-4321-8321-210987654321";
  const fixture = await setup({
    ready: () => true,
    async run() {
      return {
        status: "success",
        model: "openclip-vit-b32-laion2b",
        dimensions: 512,
        batch_embeddings: [
          { image: "catalog-0.image", embedding: vector },
          { image: "catalog-1.image", error_code: "INVALID_CATALOG_IMAGE" },
        ],
      };
    },
  });
  try {
    const body = {
      task: "image_embedding",
      catalog_index: true,
      catalog_product_ids: [product, other],
      consent: true,
      confirmed: true,
      idempotency_key: "batch-key-123",
    };
    await assert.rejects(() => fixture.service.create("guest", body), {
      code: "RBAC_DENIED",
    });
    const job = await fixture.service.create("operator", body, true);
    const result = await terminal(fixture.service, "operator", job.id);
    assert.deepEqual(result.index_summary, {
      indexed: 1,
      failed: 1,
      errors: [{ product_id: other, error: "INVALID_CATALOG_IMAGE" }],
    });
    const matches = await new LocalImageVectorRepository(fixture.root).search(
      vector,
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0].product_id, product);
  } finally {
    await fixture.close();
  }
});
test("An invalid vector anywhere in a batch prevents partial catalog index publication", async () => {
  const other = "87654321-4321-4321-8321-210987654321";
  const fixture = await setup({
    ready: () => true,
    async run() {
      return {
        status: "success",
        model: "openclip-vit-b32-laion2b",
        dimensions: 512,
        batch_embeddings: [
          { image: "catalog-0.image", embedding: vector },
          { image: "catalog-1.image", embedding: Array(1536).fill(1) },
        ],
      };
    },
  });
  try {
    const job = await fixture.service.create(
      "operator",
      {
        task: "image_embedding",
        catalog_index: true,
        catalog_product_ids: [product, other],
        consent: true,
        confirmed: true,
        idempotency_key: "invalid-batch-123",
      },
      true,
    );
    assert.equal(
      (await terminal(fixture.service, "operator", job.id)).status,
      "failed",
    );
    assert.deepEqual(
      await new LocalImageVectorRepository(fixture.root).search(vector),
      [],
    );
  } finally {
    await fixture.close();
  }
});
test("Studio preview reads only registered licensed raster assets and rejects traversal/unlicensed files", async () => {
  const fixture = await setup(worker);
  try {
    const studioRoot = join(fixture.root, "studio");
    await mkdir(studioRoot);
    await writeFile(join(studioRoot, "female.png"), PNG);
    process.env.AI_STUDIO_ASSET_ROOT = studioRoot;
    process.env.AI_STUDIO_ASSETS = JSON.stringify({
      female: {
        file: "female.png",
        label: "Studio nữ mô phỏng",
        licensed: true,
      },
      unlicensed: { file: "female.png", licensed: false },
      outside: { file: "../outside.png", licensed: true },
    });
    const shop = new ShopAiCatalog();
    assert.deepEqual(await shop.studio("female"), PNG);
    await assert.rejects(() => shop.studio("unlicensed"), {
      code: "STUDIO_UNAVAILABLE",
    });
    await assert.rejects(() => shop.studio("outside"), {
      code: "STUDIO_UNAVAILABLE",
    });
    await assert.rejects(() => shop.studio("../female"), {
      code: "STUDIO_UNAVAILABLE",
    });
    const service = new AiService(fixture.repo, worker, shop);
    const preview = await service.studioPreview("female");
    assert.equal(preview.mime, "image/png");
    assert.deepEqual(preview.bytes, PNG);
    await service.close();
  } finally {
    await fixture.close();
  }
});
