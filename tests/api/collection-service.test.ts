import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HttpError } from "../../apps/api/src/http.js";
import { createCollectionService } from "../../apps/api/src/collections/collection-service.js";
import type { CollectionRepository } from "../../apps/api/src/collections/collection-repository.js";
import type { Collection } from "../../apps/api/src/collections/collection-types.js";

const IMG = (n: number) => `/assets/images/models/model_cutout_${n}.png`;
const COMBO_A = "11111111-1111-4111-8111-111111111111";
const COMBO_B = "22222222-2222-4222-8222-222222222222";
const PLAIN = "33333333-3333-4333-8333-333333333333";
const MISSING = "44444444-4444-4444-8444-444444444444";

function baseCollection(overrides: Partial<Collection> = {}): Collection {
  return {
    collection_id: "c-1",
    code: "soft-ceremony",
    name: "Soft Ceremony",
    label: "Thanh lịch",
    col_number: "COLLECTION 01",
    script: "in bloom",
    hero_gradient: "linear-gradient(115deg, #D9D7C8 0%, #EEE6D9 48%, #E9D4CE 100%)",
    badge: "ELEGANT",
    kicker: "THE ART OF SOFTNESS",
    story_headline: "Dịu dàng",
    story_desc: "Mô tả Soft Ceremony",
    explore_cta: "Khám phá",
    category_link: "/products?category=dam-vay",
    products_sub: "SELECTED",
    products_title: "Nổi bật",
    closing_quote: "Một chút lãng mạn",
    models: [IMG(1), IMG(2), IMG(3), IMG(4), IMG(5)],
    story_paragraphs: ["Đoạn 1"],
    hero_mode: "models",
    home_model_url: IMG(1),
    show_on_home: true,
    home_sort_order: 0,
    product_ids: [COMBO_A],
    is_active: true,
    sort_order: 1,
    ...overrides,
  };
}

/** Repo giả. `catalog` ánh xạ product_id -> is_combo; id vắng mặt = không tồn tại. */
function mockCollectionRepo(initial: Collection[] = [baseCollection()], catalog?: Map<string, boolean>) {
  const collections = initial;
  const products = catalog ?? new Map<string, boolean>([[COMBO_A, true], [COMBO_B, true], [PLAIN, false]]);
  const repo: CollectionRepository = {
    async listCollections(filter) {
      return collections.filter((c) => !(typeof filter?.is_active === "boolean" && c.is_active !== filter.is_active));
    },
    async getCollectionById(id) {
      return collections.find((c) => c.collection_id === id) || null;
    },
    async getCollectionByCode(code) {
      return collections.find((c) => c.code === code) || null;
    },
    async createCollection(input) {
      const collection: Collection = baseCollection({
        collection_id: `c-${collections.length + 1}`,
        code: input.code,
        name: input.name,
        label: input.label || input.name,
        story_desc: input.story_desc,
        models: input.models || [],
        hero_mode: input.hero_mode || "models",
        home_model_url: input.home_model_url ?? null,
        show_on_home: input.show_on_home ?? false,
        home_sort_order: input.home_sort_order ?? 0,
        product_ids: input.product_ids || [],
        banner_url: input.banner_url ?? null,
        is_active: input.is_active ?? true,
        sort_order: input.sort_order ?? 0,
      });
      collections.push(collection);
      return collection;
    },
    async updateCollection(id, input) {
      const existing = collections.find((c) => c.collection_id === id);
      if (!existing) return null;
      Object.assign(existing, input);
      return existing;
    },
    async deleteCollection(id) {
      const index = collections.findIndex((c) => c.collection_id === id);
      if (index >= 0) collections.splice(index, 1);
      return true;
    },
    async findComboProductIds(ids) {
      const found = new Map<string, boolean>();
      for (const id of ids) if (products.has(id)) found.set(id, products.get(id) === true);
      return found;
    },
  };
  return { repo, collections };
}

function service(initial?: Collection[], catalog?: Map<string, boolean>) {
  const { repo, collections } = mockCollectionRepo(initial, catalog);
  return { svc: createCollectionService({ repository: repo }), collections };
}

const validCreate = {
  code: "urban-vibe",
  name: "Urban Vibe",
  story_desc: "Bộ sưu tập mới",
  models: [IMG(1), IMG(2), IMG(3), IMG(4), IMG(5)],
};

async function rejectsWith(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    return err instanceof HttpError && err.code === code && (status === undefined || err.status === status);
  });
}

test("CollectionService: lists public collections with the new CMS fields", async () => {
  const { svc } = service([baseCollection(), baseCollection({ collection_id: "c-2", code: "hidden", is_active: false })]);
  const list = await svc.listPublicCollections();
  assert.equal(list.length, 1);
  assert.equal(list[0].code, "soft-ceremony");
  assert.equal(list[0].hero_mode, "models");
  assert.equal(list[0].home_model_url, IMG(1));
  assert.equal(list[0].show_on_home, true);
  assert.equal(list[0].home_sort_order, 0);
  assert.deepEqual(list[0].product_ids, [COMBO_A]);
});

test("CollectionService: prevents duplicate collection code", async () => {
  const { svc } = service();
  await rejectsWith(svc.createCollection({ ...validCreate, code: "soft-ceremony" }), "CODE_ALREADY_EXISTS", 409);
});

test("CollectionService: creates new collection with formatted slug code and label defaulting to name", async () => {
  const { svc } = service();
  const created = await svc.createCollection({ ...validCreate, code: "Urban Vibe 2027" });
  assert.equal(created.code, "urban-vibe-2027");
  assert.equal(created.models.length, 5);
  assert.equal(created.label, "Urban Vibe");
});

test("CollectionService: create requires name, code and story_desc", async () => {
  const { svc } = service();
  await rejectsWith(svc.createCollection({ ...validCreate, name: "  " }), "NAME_REQUIRED", 400);
  await rejectsWith(svc.createCollection({ ...validCreate, code: " " }), "CODE_REQUIRED", 400);
  await rejectsWith(svc.createCollection({ ...validCreate, story_desc: "" }), "STORY_DESC_REQUIRED", 400);
});

test("CollectionService: code must be a slug of at most 60 characters", async () => {
  const { svc } = service();
  await rejectsWith(svc.createCollection({ ...validCreate, code: "Bộ sưu tập" }), "CODE_INVALID", 400);
  await rejectsWith(svc.createCollection({ ...validCreate, code: "a".repeat(61) }), "CODE_INVALID", 400);
});

test("CollectionService: code is immutable after creation", async () => {
  const { svc } = service();
  await rejectsWith(svc.updateCollection("c-1", { code: "other-code" }), "CODE_IMMUTABLE", 400);
  const same = await svc.updateCollection("c-1", { code: "Soft Ceremony".toLowerCase().replace(" ", "-"), name: "Soft Ceremony 2" });
  assert.equal(same.name, "Soft Ceremony 2");
  assert.equal(same.code, "soft-ceremony");
});

test("CollectionService: update of an unknown id is 404", async () => {
  const { svc } = service();
  await rejectsWith(svc.updateCollection("nope", { name: "X" }), "COLLECTION_NOT_FOUND", 404);
});

test("CollectionService: field length limits raise FIELD_TOO_LONG", async () => {
  const { svc } = service();
  const cases: Array<Record<string, string>> = [
    { name: "n".repeat(81) },
    { story_desc: "d".repeat(601) },
    { home_story: "h".repeat(161) },
    { kicker: "k".repeat(61) },
    { story_headline: "s".repeat(121) },
    { explore_cta: "e".repeat(41) },
    { products_sub: "p".repeat(41) },
    { products_title: "t".repeat(81) },
    { closing_quote: "q".repeat(201) },
    { script: "x".repeat(41) },
    { col_number: "c".repeat(61) },
    { badge: "b".repeat(31) },
  ];
  for (const patch of cases) {
    await rejectsWith(svc.updateCollection("c-1", patch), "FIELD_TOO_LONG", 400);
  }
});

test("CollectionService: story_desc cannot be blanked on update", async () => {
  const { svc } = service();
  await rejectsWith(svc.updateCollection("c-1", { story_desc: "   " }), "STORY_DESC_REQUIRED", 400);
});

test("CollectionService: home_story accepts 160 chars and empty becomes null", async () => {
  const { svc } = service();
  const ok = await svc.updateCollection("c-1", { home_story: "h".repeat(160) });
  assert.equal(ok.home_story?.length, 160);
  const cleared = await svc.updateCollection("c-1", { home_story: "" });
  assert.equal(cleared.home_story, null);
});

test("CollectionService: category_link must be internal path or https", async () => {
  const { svc } = service();
  for (const bad of ["javascript:alert(1)", "//evil.example", "http://insecure.example", "products", "data:text/html,x"]) {
    await rejectsWith(svc.updateCollection("c-1", { category_link: bad }), "INVALID_LINK_URL", 400);
  }
  const ok = await svc.updateCollection("c-1", { category_link: "https://velura.example/products" });
  assert.equal(ok.category_link, "https://velura.example/products");
});

test("CollectionService: hero_gradient must be a linear-gradient", async () => {
  const { svc } = service();
  await rejectsWith(svc.updateCollection("c-1", { hero_gradient: "red; background:url(x)" }), "INVALID_GRADIENT", 400);
  await rejectsWith(svc.updateCollection("c-1", { hero_gradient: "linear-gradient(red);{" }), "INVALID_GRADIENT", 400);
  const ok = await svc.updateCollection("c-1", { hero_gradient: "linear-gradient(90deg, #fff 0%, #000 100%)" });
  assert.match(ok.hero_gradient, /^linear-gradient\(/);
});

test("CollectionService: media URLs allow https and /assets/ only", async () => {
  const { svc } = service();
  for (const bad of ["javascript:alert(1)", "data:image/png;base64,AAAA", "//cdn.example/x.png", "http://cdn.example/x.png", "/other/x.png"]) {
    await rejectsWith(svc.updateCollection("c-1", { banner_url: bad }), "INVALID_MEDIA_URL", 400);
    await rejectsWith(svc.updateCollection("c-1", { home_model_url: bad }), "INVALID_MEDIA_URL", 400);
  }
  await rejectsWith(
    svc.updateCollection("c-1", { models: [IMG(1), IMG(2), IMG(3), IMG(4), "javascript:alert(1)"] }),
    "INVALID_MEDIA_URL",
    400
  );
  await rejectsWith(
    svc.updateCollection("c-1", { banner_url: `https://cdn.example/${"a".repeat(500)}.png` }),
    "INVALID_MEDIA_URL",
    400
  );
  const ok = await svc.updateCollection("c-1", { banner_url: "https://cdn.jsdelivr.net/gh/x/cover.png" });
  assert.equal(ok.banner_url, "https://cdn.jsdelivr.net/gh/x/cover.png");
});

test("CollectionService: models holds at most 5 images", async () => {
  const { svc } = service();
  await rejectsWith(svc.updateCollection("c-1", { models: [IMG(1), IMG(2), IMG(3), IMG(4), IMG(5), IMG(1)] }), "MODELS_TOO_MANY", 400);
});

test("CollectionService: hero_mode cover needs a cover image (partial patch uses merged record)", async () => {
  const { svc } = service();
  await rejectsWith(svc.updateCollection("c-1", { hero_mode: "cover" }), "COVER_REQUIRED", 400);
  const withCover = await svc.updateCollection("c-1", { banner_url: "/assets/images/cover.png", hero_mode: "cover" });
  assert.equal(withCover.hero_mode, "cover");
  // Đã có ảnh bìa từ lần lưu trước: patch chỉ gồm hero_mode vẫn hợp lệ.
  const { svc: svc2 } = service([baseCollection({ banner_url: "/assets/images/cover.png" })]);
  const ok = await svc2.updateCollection("c-1", { hero_mode: "cover" });
  assert.equal(ok.hero_mode, "cover");
  // Xóa ảnh bìa khi đang ở chế độ cover bị chặn.
  await rejectsWith(svc2.updateCollection("c-1", { banner_url: null }), "COVER_REQUIRED", 400);
});

test("CollectionService: rejects an unknown hero_mode", async () => {
  const { svc } = service();
  await rejectsWith(svc.updateCollection("c-1", { hero_mode: "video" as never }), "INVALID_HERO_MODE", 400);
});

test("CollectionService: active models mode requires exactly 5 models; drafts and cover mode are exempt", async () => {
  const { svc } = service();
  await rejectsWith(svc.updateCollection("c-1", { models: [IMG(1), IMG(2)] }), "MODELS_REQUIRED", 400);
  await rejectsWith(svc.createCollection({ ...validCreate, models: [IMG(1)] }), "MODELS_REQUIRED", 400);
  const draft = await svc.updateCollection("c-1", { models: [IMG(1), IMG(2)], is_active: false });
  assert.equal(draft.models.length, 2);
  // Bật lại bản nháp thiếu ảnh bị chặn dù patch chỉ có is_active.
  await rejectsWith(svc.updateCollection("c-1", { is_active: true }), "MODELS_REQUIRED", 400);
  const cover = await svc.updateCollection("c-1", { banner_url: "/assets/images/cover.png", hero_mode: "cover", is_active: true });
  assert.equal(cover.is_active, true);
});

test("CollectionService: show_on_home requires a home model image", async () => {
  const { svc } = service([baseCollection({ show_on_home: false, home_model_url: null })]);
  await rejectsWith(svc.updateCollection("c-1", { show_on_home: true }), "HOME_MODEL_REQUIRED", 400);
  const ok = await svc.updateCollection("c-1", { show_on_home: true, home_model_url: IMG(3) });
  assert.equal(ok.show_on_home, true);
});

test("CollectionService: at most 5 active collections can be on the homepage", async () => {
  const five = [1, 2, 3, 4, 5].map((n) =>
    baseCollection({ collection_id: `h-${n}`, code: `home-${n}`, name: `Home ${n}`, home_model_url: IMG(n), home_sort_order: n })
  );
  const sixth = baseCollection({ collection_id: "x-6", code: "sixth", name: "Sixth", show_on_home: false, home_model_url: IMG(1) });
  const { svc } = service([...five, sixth]);
  await rejectsWith(svc.updateCollection("x-6", { show_on_home: true }), "HOME_SLOTS_FULL", 409);
  await rejectsWith(svc.createCollection({ ...validCreate, show_on_home: true, home_model_url: IMG(2) }), "HOME_SLOTS_FULL", 409);
  // Sửa chính một collection đang chiếm slot không bị tính hai lần.
  const self = await svc.updateCollection("h-1", { home_sort_order: 9 });
  assert.equal(self.home_sort_order, 9);
  // Collection không hoạt động không chiếm slot.
  const hidden = await svc.updateCollection("x-6", { is_active: false, show_on_home: true });
  assert.equal(hidden.show_on_home, true);
  // Giải phóng một slot rồi thêm được.
  await svc.updateCollection("h-5", { show_on_home: false });
  const added = await svc.updateCollection("x-6", { is_active: true });
  assert.equal(added.is_active, true);
});

test("CollectionService: product_ids are de-duplicated in first-seen order and must be combos", async () => {
  const { svc } = service();
  const ok = await svc.updateCollection("c-1", { product_ids: [COMBO_B, COMBO_A, COMBO_B.toUpperCase()] });
  assert.deepEqual(ok.product_ids, [COMBO_B, COMBO_A]);
  await rejectsWith(svc.updateCollection("c-1", { product_ids: [COMBO_A, PLAIN] }), "PRODUCT_NOT_COMBO", 400);
  await rejectsWith(svc.updateCollection("c-1", { product_ids: [MISSING] }), "PRODUCT_NOT_FOUND", 400);
  await rejectsWith(svc.updateCollection("c-1", { product_ids: ["not-a-uuid"] }), "PRODUCT_IDS_INVALID", 400);
  await rejectsWith(svc.updateCollection("c-1", { product_ids: "x" as never }), "PRODUCT_IDS_INVALID", 400);
});

test("CollectionService: product_ids allows at most 10 distinct ids", async () => {
  const ids = Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const catalog = new Map(ids.map((id) => [id, true] as const));
  const { svc } = service(undefined, catalog);
  await rejectsWith(svc.updateCollection("c-1", { product_ids: ids }), "PRODUCT_IDS_INVALID", 400);
  const ok = await svc.updateCollection("c-1", { product_ids: ids.slice(0, 10) });
  assert.equal(ok.product_ids.length, 10);
  const cleared = await svc.updateCollection("c-1", { product_ids: [] });
  assert.deepEqual(cleared.product_ids, []);
});

test("CollectionService: sort orders are integers between 0 and 9999", async () => {
  const { svc } = service();
  for (const patch of [{ sort_order: -1 }, { sort_order: 10000 }, { sort_order: 1.5 }, { home_sort_order: -1 }, { home_sort_order: 10000 }]) {
    await rejectsWith(svc.updateCollection("c-1", patch), "INVALID_SORT_ORDER", 400);
  }
  const ok = await svc.updateCollection("c-1", { sort_order: 9999, home_sort_order: 0 });
  assert.equal(ok.sort_order, 9999);
});

test("CollectionService: blank label falls back to name; label is trimmed", async () => {
  const { svc } = service();
  const updated = await svc.updateCollection("c-1", { name: "Soft Ceremony II", label: "  " });
  assert.equal(updated.label, "Soft Ceremony II");
  const labelled = await svc.updateCollection("c-1", { label: "  Nhãn mới " });
  assert.equal(labelled.label, "Nhãn mới");
});

test("CollectionService: name is trimmed and limited to 80 characters", async () => {
  const { svc } = service();
  const updated = await svc.updateCollection("c-1", { name: "  Tên mới  " });
  assert.equal(updated.name, "Tên mới");
  await rejectsWith(svc.updateCollection("c-1", { name: "   " }), "NAME_REQUIRED", 400);
});

test("migration 132 adds the CMS columns idempotently without destructive statements", () => {
  const sql = readFileSync(fileURLToPath(new URL("../../database/migrations/132_collections_cms_production_fields.sql", import.meta.url)), "utf8");
  for (const column of ["hero_mode", "home_model_url", "show_on_home", "home_sort_order", "product_ids"]) {
    assert.match(sql, new RegExp(`add column if not exists ${column}\\b`, "i"), `${column} column`);
  }
  assert.match(sql, /check \(hero_mode in \('models','cover'\)\)/i);
  assert.doesNotMatch(sql, /\bdrop\b/i);
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
});
