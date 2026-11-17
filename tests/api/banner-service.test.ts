import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../../apps/api/src/http.js";
import { createBannerService } from "../../apps/api/src/banners/banner-service.js";
import type { BannerRepository } from "../../apps/api/src/banners/banner-repository.js";
import type { Banner } from "../../apps/api/src/banners/banner-types.js";

function mockBannerRepo(): BannerRepository {
  const banners: Banner[] = [
    {
      banner_id: "b-1",
      placement: "products_hero",
      title: "Summer Collection",
      subtitle: "Fresh linen essentials",
      tag_label: "EDITORIAL",
      media_type: "image",
      media_url: "https://example.com/banner.jpg",
      poster_url: null,
      button_text: "Xem ngay",
      link_url: "/products",
      is_active: true,
      sort_order: 1,
      metadata: {},
    },
    {
      banner_id: "b-2",
      placement: "products_hero",
      title: "Hero Look",
      subtitle: null,
      tag_label: null,
      media_type: "video",
      media_url: "/assets/videos/hero-bg.mp4",
      poster_url: "https://example.com/poster.jpg",
      button_text: "Khám phá",
      link_url: "/collections",
      is_active: false,
      sort_order: 2,
      metadata: {},
    },
  ];

  return {
    async listBanners(filter) {
      return banners.filter((b) => {
        if (filter?.placement && b.placement !== filter.placement) return false;
        if (typeof filter?.is_active === "boolean" && b.is_active !== filter.is_active) return false;
        return true;
      });
    },
    async getBannerById(id) {
      return banners.find((b) => b.banner_id === id) || null;
    },
    async createBanner(input) {
      const banner: Banner = {
        banner_id: `b-${banners.length + 1}`,
        placement: input.placement,
        title: input.title,
        subtitle: input.subtitle || null,
        tag_label: input.tag_label || null,
        media_type: input.media_type || "image",
        media_url: input.media_url,
        poster_url: input.poster_url || null,
        button_text: input.button_text || null,
        link_url: input.link_url || null,
        is_active: input.is_active ?? true,
        sort_order: input.sort_order ?? 0,
        metadata: input.metadata || {},
      };
      banners.push(banner);
      return banner;
    },
    async updateBanner(id, input) {
      const existing = banners.find((b) => b.banner_id === id);
      if (!existing) return null;
      Object.assign(existing, input);
      return existing;
    },
    async deleteBanner(id) {
      const index = banners.findIndex((b) => b.banner_id === id);
      if (index >= 0) banners.splice(index, 1);
      return true;
    },
  };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof HttpError && err.code === code);
}

const valid = { placement: "products_hero", title: "Banner", media_url: "https://example.com/test.jpg" } as const;

test("BannerService: lists active banners for public", async () => {
  const service = createBannerService({ repository: mockBannerRepo() });
  const publicBanners = await service.listPublicBanners("products_hero");
  assert.equal(publicBanners.length, 1);
  assert.equal(publicBanners[0].title, "Summer Collection");
});

test("BannerService: validates required title and media_url", async () => {
  const service = createBannerService({ repository: mockBannerRepo() });
  await rejectsWith(service.createBanner({ ...valid, title: "" }), "TITLE_REQUIRED");
  await rejectsWith(service.createBanner({ ...valid, media_url: "   " }), "MEDIA_URL_REQUIRED");
});

test("BannerService: creates and updates a banner successfully", async () => {
  const service = createBannerService({ repository: mockBannerRepo() });
  const created = await service.createBanner({
    placement: "products_hero",
    title: "New Video Banner",
    media_type: "video",
    media_url: "https://example.com/new.mp4",
  });
  assert.equal(created.title, "New Video Banner");

  const updated = await service.updateBanner(created.banner_id, { title: "Updated Video Banner" });
  assert.equal(updated.title, "Updated Video Banner");
});

test("BannerService: home_hero and collections_hero placements are rejected", async () => {
  const service = createBannerService({ repository: mockBannerRepo() });
  await rejectsWith(service.createBanner({ ...valid, placement: "home_hero" as never }), "INVALID_PLACEMENT");
  await rejectsWith(service.createBanner({ ...valid, placement: "collections_hero" as never }), "INVALID_PLACEMENT");
  await rejectsWith(service.updateBanner("b-1", { placement: "home_hero" as never }), "INVALID_PLACEMENT");
  await rejectsWith(service.listPublicBanners("home_hero"), "INVALID_PLACEMENT");
});

test("BannerService: link_url must be internal path or https", async () => {
  const service = createBannerService({ repository: mockBannerRepo() });
  for (const bad of ["javascript:alert(1)", "//evil.example", "http://insecure.example", "products"]) {
    await rejectsWith(service.createBanner({ ...valid, link_url: bad }), "INVALID_LINK_URL");
    await rejectsWith(service.updateBanner("b-1", { link_url: bad }), "INVALID_LINK_URL");
  }
  const internal = await service.createBanner({ ...valid, link_url: "/collections" });
  assert.equal(internal.link_url, "/collections");
  const external = await service.createBanner({ ...valid, link_url: "https://velura.example/x" });
  assert.equal(external.link_url, "https://velura.example/x");
  const empty = await service.createBanner({ ...valid, link_url: "" });
  assert.equal(empty.link_url, null);
});

test("BannerService: media_url and poster_url must be https or /assets/", async () => {
  const service = createBannerService({ repository: mockBannerRepo() });
  for (const bad of ["javascript:alert(1)", "data:image/png;base64,AAAA", "//cdn.example/x.png", "http://cdn.example/x.png"]) {
    await rejectsWith(service.createBanner({ ...valid, media_url: bad }), "INVALID_MEDIA_URL");
    await rejectsWith(service.createBanner({ ...valid, poster_url: bad }), "INVALID_MEDIA_URL");
    await rejectsWith(service.updateBanner("b-1", { media_url: bad }), "INVALID_MEDIA_URL");
  }
  const ok = await service.createBanner({ ...valid, media_url: "/assets/videos/hero-bg.mp4", poster_url: "/assets/images/p.png" });
  assert.equal(ok.media_url, "/assets/videos/hero-bg.mp4");
});

test("BannerService: enforces field lengths", async () => {
  const service = createBannerService({ repository: mockBannerRepo() });
  await rejectsWith(service.createBanner({ ...valid, title: "t".repeat(121) }), "FIELD_TOO_LONG");
  await rejectsWith(service.createBanner({ ...valid, subtitle: "s".repeat(241) }), "FIELD_TOO_LONG");
  await rejectsWith(service.createBanner({ ...valid, button_text: "b".repeat(41) }), "FIELD_TOO_LONG");
  await rejectsWith(service.updateBanner("b-1", { title: "t".repeat(121) }), "FIELD_TOO_LONG");
  const ok = await service.createBanner({ ...valid, title: "t".repeat(120), subtitle: "s".repeat(240), button_text: "b".repeat(40) });
  assert.equal(ok.title.length, 120);
});

test("BannerService: sort_order must be a non-negative integer", async () => {
  const service = createBannerService({ repository: mockBannerRepo() });
  await rejectsWith(service.createBanner({ ...valid, sort_order: -1 }), "INVALID_SORT_ORDER");
  await rejectsWith(service.updateBanner("b-1", { sort_order: 1.5 }), "INVALID_SORT_ORDER");
  const ok = await service.updateBanner("b-1", { sort_order: 0 });
  assert.equal(ok.sort_order, 0);
});

test("BannerService: update of an unknown id is 404", async () => {
  const service = createBannerService({ repository: mockBannerRepo() });
  await rejectsWith(service.updateBanner("nope", { title: "X" }), "BANNER_NOT_FOUND");
});
