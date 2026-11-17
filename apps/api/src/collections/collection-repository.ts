import { deleteRows, insertRow, selectOne, selectRows, updateRows } from "../supabase.js";
import type { Collection, CreateCollectionInput, UpdateCollectionInput } from "./collection-types.js";

const COLLECTION_SELECT = "collection_id,code,name,label,banner_url,decor_url,home_story,col_number,script,hero_gradient,badge,kicker,story_headline,story_desc,explore_cta,category_link,products_sub,products_title,closing_quote,quote,models,story_paragraphs,styling_metadata,hero_mode,home_model_url,show_on_home,home_sort_order,product_ids,is_active,sort_order,created_at,updated_at";

export interface CollectionRepository {
  listCollections(filter?: { is_active?: boolean }): Promise<Collection[]>;
  getCollectionById(id: string): Promise<Collection | null>;
  getCollectionByCode(code: string): Promise<Collection | null>;
  createCollection(input: CreateCollectionInput): Promise<Collection>;
  updateCollection(id: string, input: UpdateCollectionInput): Promise<Collection | null>;
  deleteCollection(id: string): Promise<boolean>;
  /**
   * Tra cứu sản phẩm theo id. Trả về map `product_id -> is_combo`; id không tồn tại
   * trong catalog sẽ vắng mặt trong map.
   */
  findComboProductIds(ids: string[]): Promise<Map<string, boolean>>;
}

export function createCollectionRepository(): CollectionRepository {
  return {
    async listCollections(filter) {
      const query: Record<string, unknown> = {
        select: COLLECTION_SELECT,
        order: "sort_order.asc,created_at.asc",
      };
      if (typeof filter?.is_active === "boolean") {
        query.is_active = `eq.${filter.is_active}`;
      }

      const res = await selectRows("collections", query);
      return (res.rows || []) as unknown as Collection[];
    },

    async getCollectionById(id: string) {
      const row = await selectOne("collections", {
        collection_id: `eq.${id}`,
        select: COLLECTION_SELECT,
      });
      return (row as unknown as Collection) || null;
    },

    async getCollectionByCode(code: string) {
      const row = await selectOne("collections", {
        code: `eq.${code}`,
        select: COLLECTION_SELECT,
      });
      return (row as unknown as Collection) || null;
    },

    async createCollection(input: CreateCollectionInput) {
      const row = await insertRow("collections", {
        code: input.code,
        name: input.name,
        label: input.label || input.name,
        banner_url: input.banner_url ?? null,
        decor_url: input.decor_url ?? null,
        home_story: input.home_story ?? null,
        col_number: input.col_number || "COLLECTION · SPECIAL EDITION",
        script: input.script || "velura atelier",
        hero_gradient: input.hero_gradient || "linear-gradient(115deg, #D9D7C8 0%, #EEE6D9 48%, #E9D4CE 100%)",
        badge: input.badge || "ELEGANT",
        kicker: input.kicker || "THE ART OF SOFTNESS",
        story_headline: input.story_headline || "Dịu dàng, có chủ ý.",
        story_desc: input.story_desc,
        explore_cta: input.explore_cta || "Khám phá bộ sưu tập",
        category_link: input.category_link || "/products?category=dam-vay",
        products_sub: input.products_sub || "SELECTED FOR YOU",
        products_title: input.products_title || "Những thiết kế nổi bật",
        closing_quote: input.closing_quote || "Một chút lãng mạn, vừa đủ cho riêng bạn.",
        quote: input.quote ?? null,
        models: input.models || [],
        story_paragraphs: input.story_paragraphs || [],
        styling_metadata: input.styling_metadata || {},
        hero_mode: input.hero_mode || "models",
        home_model_url: input.home_model_url ?? null,
        show_on_home: input.show_on_home ?? false,
        home_sort_order: input.home_sort_order ?? 0,
        product_ids: input.product_ids || [],
        is_active: input.is_active !== undefined ? input.is_active : true,
        sort_order: input.sort_order ?? 0,
      });
      return row as unknown as Collection;
    },

    async updateCollection(id: string, input: UpdateCollectionInput) {
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (input.code !== undefined) updateData.code = input.code;
      if (input.name !== undefined) updateData.name = input.name;
      if (input.label !== undefined) updateData.label = input.label;
      if (input.banner_url !== undefined) updateData.banner_url = input.banner_url;
      if (input.decor_url !== undefined) updateData.decor_url = input.decor_url;
      if (input.home_story !== undefined) updateData.home_story = input.home_story;
      if (input.col_number !== undefined) updateData.col_number = input.col_number;
      if (input.script !== undefined) updateData.script = input.script;
      if (input.hero_gradient !== undefined) updateData.hero_gradient = input.hero_gradient;
      if (input.badge !== undefined) updateData.badge = input.badge;
      if (input.kicker !== undefined) updateData.kicker = input.kicker;
      if (input.story_headline !== undefined) updateData.story_headline = input.story_headline;
      if (input.story_desc !== undefined) updateData.story_desc = input.story_desc;
      if (input.explore_cta !== undefined) updateData.explore_cta = input.explore_cta;
      if (input.category_link !== undefined) updateData.category_link = input.category_link;
      if (input.products_sub !== undefined) updateData.products_sub = input.products_sub;
      if (input.products_title !== undefined) updateData.products_title = input.products_title;
      if (input.closing_quote !== undefined) updateData.closing_quote = input.closing_quote;
      if (input.quote !== undefined) updateData.quote = input.quote;
      if (input.models !== undefined) updateData.models = input.models;
      if (input.story_paragraphs !== undefined) updateData.story_paragraphs = input.story_paragraphs;
      if (input.styling_metadata !== undefined) updateData.styling_metadata = input.styling_metadata;
      if (input.hero_mode !== undefined) updateData.hero_mode = input.hero_mode;
      if (input.home_model_url !== undefined) updateData.home_model_url = input.home_model_url;
      if (input.show_on_home !== undefined) updateData.show_on_home = input.show_on_home;
      if (input.home_sort_order !== undefined) updateData.home_sort_order = input.home_sort_order;
      if (input.product_ids !== undefined) updateData.product_ids = input.product_ids;
      if (input.is_active !== undefined) updateData.is_active = input.is_active;
      if (input.sort_order !== undefined) updateData.sort_order = input.sort_order;

      const updated = await updateRows("collections", { collection_id: `eq.${id}` }, updateData);
      return (updated[0] as unknown as Collection) || null;
    },

    async deleteCollection(id: string) {
      await deleteRows("collections", { collection_id: `eq.${id}` });
      return true;
    },

    async findComboProductIds(ids: string[]) {
      const result = new Map<string, boolean>();
      if (ids.length === 0) return result;
      const res = await selectRows("product", {
        product_id: `in.(${ids.join(",")})`,
        select: "product_id,is_combo",
      }, { count: "none" });
      for (const row of res.rows || []) {
        result.set(String(row.product_id), row.is_combo === true);
      }
      return result;
    },
  };
}
