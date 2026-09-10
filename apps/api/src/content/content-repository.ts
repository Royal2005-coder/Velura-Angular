import { selectOne, selectRows } from "../supabase.js";
import { asNumber, asString, isJsonObject, type JsonObject } from "../types.js";

/**
 * Filters for listing published blog posts.
 */
export interface BlogListFilters {
  categorySlug?: string;
  featuredFirst: boolean;
  limit: number;
  offset: number;
}

/**
 * PostgREST accessors for public content (blogs, policies, static pages).
 */
export function createContentRepository() {
  return {
    async listCategories(type: string | undefined) {
      const query: Record<string, unknown> = {
        select: "content_category_id,content_type,slug,name,display_order",
        order: "display_order.asc,name.asc"
      };

      if (type) {
        query.content_type = `eq.${type}`;
      }

      const result = await selectRows("content_category", query);
      const rows = (result.rows || []).map((row) => ({
        content_category_id: row.content_category_id,
        content_type: row.content_type,
        slug: row.slug,
        name: row.name,
        display_order: row.display_order
      }));
      return { rows };
    },

    async listBlogs(filters: BlogListFilters) {
      const query: Record<string, unknown> = {
        select: "blog_id,category_slug,slug,title,excerpt,content,image_url,author,read_minutes,is_featured,status,published_at,updated_at",
        status: "eq.published",
        order: filters.featuredFirst
          ? "is_featured.desc,published_at.desc"
          : "published_at.desc",
        limit: filters.limit,
        offset: filters.offset
      };

      if (filters.categorySlug) {
        query.category_slug = `eq.${filters.categorySlug}`;
      }

      const result = await selectRows("blog", query);
      return {
        rows: (result.rows || []).map(toBlogDto),
        count: result.count
      };
    },

    async getBlog(slug: string) {
      const row = await selectOne("blog", {
        select: "blog_id,category_slug,slug,title,excerpt,content,image_url,author,read_minutes,is_featured,status,published_at,updated_at",
        status: "eq.published",
        slug: `eq.${slug}`
      });
      return row ? toBlogDto(row) : null;
    },

    async listPolicies() {
      const result = await selectRows("policy", {
        select: "policy_id,slug,title,summary,content,display_order,status,updated_at",
        status: "eq.published",
        order: "display_order.asc,title.asc"
      });

      return {
        rows: (result.rows || []).map(toPolicyDto),
        count: result.count
      };
    },

    async getPolicy(slug: string) {
      const row = await selectOne("policy", {
        select: "policy_id,slug,title,summary,content,display_order,status,updated_at",
        status: "eq.published",
        slug: `eq.${slug}`
      });
      return row ? toPolicyDto(row) : null;
    },

    async getStaticPage(slug: string) {
      const row = await selectOne("static_page", {
        select: "static_page_id,slug,title,subtitle,content,status,updated_at",
        status: "eq.published",
        slug: `eq.${slug}`
      });
      if (!row) return null;

      return {
        static_page_id: row.static_page_id,
        slug: row.slug,
        title: row.title,
        subtitle: row.subtitle || row.title,
        content: normalizeObject(row.content),
        updated_at: row.updated_at
      };
    }
  };
}

/**
 * Repository returned by `createContentRepository`.
 */
export type ContentRepository = ReturnType<typeof createContentRepository>;

function toBlogDto(row: JsonObject): JsonObject {
  return {
    blog_id: row.blog_id,
    category_slug: asString(row.category_slug) || "trend",
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    content: row.content,
    image_url: asString(row.image_url) || "/src/assets/images/image-8.png",
    author: asString(row.author) || "Velura Editorial",
    read_minutes: asNumber(row.read_minutes) || 5,
    is_featured: Boolean(row.is_featured),
    status: row.status,
    published_at: row.published_at,
    updated_at: row.updated_at
  };
}

function toPolicyDto(row: JsonObject): JsonObject {
  return {
    policy_id: row.policy_id,
    slug: row.slug,
    title: row.title,
    summary: asString(row.summary) || "",
    content: normalizeArray(row.content),
    display_order: row.display_order,
    updated_at: row.updated_at
  };
}

function normalizeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value as unknown[];
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as unknown[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeObject(value: unknown): JsonObject {
  if (isJsonObject(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isJsonObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}
