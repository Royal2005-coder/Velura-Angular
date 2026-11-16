import assert from "node:assert/strict";
import test from "node:test";
import { createBannerService } from "./banner-service.js";
import type { BannerRepository } from "./banner-repository.js";
import type { Banner } from "./banner-types.js";

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
      placement: "home_hero",
      title: "Hero Look",
      subtitle: null,
      tag_label: null,
      media_type: "video",
      media_url: "https://example.com/video.mp4",
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

test("BannerService: lists active banners for public", async () => {
  const service = createBannerService({ repository: mockBannerRepo() });
  const publicBanners = await service.listPublicBanners("products_hero");
  assert.equal(publicBanners.length, 1);
  assert.equal(publicBanners[0].title, "Summer Collection");
});

test("BannerService: validates required title and media_url", async () => {
  const service = createBannerService({ repository: mockBannerRepo() });
  await assert.rejects(
    async () => {
      await service.createBanner({
        placement: "products_hero",
        title: "",
        media_url: "https://example.com/test.jpg",
      });
    },
    (err: any) => err.code === "TITLE_REQUIRED"
  );

  await assert.rejects(
    async () => {
      await service.createBanner({
        placement: "products_hero",
        title: "Test",
        media_url: "   ",
      });
    },
    (err: any) => err.code === "MEDIA_URL_REQUIRED"
  );
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

  const updated = await service.updateBanner(created.banner_id, {
    title: "Updated Video Banner",
  });
  assert.equal(updated.title, "Updated Video Banner");
});
