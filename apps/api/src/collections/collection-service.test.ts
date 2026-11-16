import assert from "node:assert/strict";
import test from "node:test";
import { createCollectionService } from "./collection-service.js";
import type { CollectionRepository } from "./collection-repository.js";
import type { Collection } from "./collection-types.js";

function mockCollectionRepo(): CollectionRepository {
  const collections: Collection[] = [
    {
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
      models: ["/model1.png", "/model2.png"],
      story_paragraphs: ["Đoạn 1"],
      is_active: true,
      sort_order: 1,
    },
  ];

  return {
    async listCollections(filter) {
      return collections.filter((c) => {
        if (typeof filter?.is_active === "boolean" && c.is_active !== filter.is_active) return false;
        return true;
      });
    },
    async getCollectionById(id) {
      return collections.find((c) => c.collection_id === id) || null;
    },
    async getCollectionByCode(code) {
      return collections.find((c) => c.code === code) || null;
    },
    async createCollection(input) {
      const collection: Collection = {
        collection_id: `c-${collections.length + 1}`,
        code: input.code,
        name: input.name,
        label: input.label,
        col_number: input.col_number || "COLLECTION 02",
        script: input.script || "city muse",
        hero_gradient: input.hero_gradient || "",
        badge: input.badge || "CASUAL",
        kicker: input.kicker || "",
        story_headline: input.story_headline || "",
        story_desc: input.story_desc,
        explore_cta: input.explore_cta || "",
        category_link: input.category_link || "",
        products_sub: input.products_sub || "",
        products_title: input.products_title || "",
        closing_quote: input.closing_quote || "",
        models: input.models || [],
        story_paragraphs: input.story_paragraphs || [],
        is_active: input.is_active ?? true,
        sort_order: input.sort_order ?? 0,
      };
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
  };
}

test("CollectionService: lists public collections", async () => {
  const service = createCollectionService({ repository: mockCollectionRepo() });
  const list = await service.listPublicCollections();
  assert.equal(list.length, 1);
  assert.equal(list[0].code, "soft-ceremony");
});

test("CollectionService: prevents duplicate collection code", async () => {
  const service = createCollectionService({ repository: mockCollectionRepo() });
  await assert.rejects(
    async () => {
      await service.createCollection({
        code: "soft-ceremony",
        name: "Duplicate Name",
        label: "Thanh lịch",
        story_desc: "Mô tả trùng",
      });
    },
    (err: any) => err.code === "CODE_ALREADY_EXISTS"
  );
});

test("CollectionService: creates new collection with formatted slug code", async () => {
  const service = createCollectionService({ repository: mockCollectionRepo() });
  const created = await service.createCollection({
    code: "Urban Vibe 2027",
    name: "Urban Vibe",
    label: "Phong cách mới",
    story_desc: "Bộ sưu tập mới đầy sáng tạo",
    models: ["/img1.png", "/img2.png", "/img3.png"],
  });
  assert.equal(created.code, "urban-vibe-2027");
  assert.equal(created.models.length, 3);
});
