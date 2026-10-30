import { callRpc } from "../supabase.js";
import type { JsonObject } from "../types.js";

/**
 * Truy cập các RPC biên tập nội dung (migration 078).
 *
 * RPC chạy với token của người gọi (`useAnonKey` + Authorization): quyền admin và audit do
 * chính hàm trong Postgres kiểm tra, nên tầng API không tự ghi `audit_log` một lần nữa.
 */
export interface ContentAdminRepository {
  listBlogs(input: { status: string; search: string; limit: number; offset: number }, accessToken: string | null): Promise<JsonObject>;
  upsertBlog(input: JsonObject, accessToken: string | null): Promise<JsonObject>;
}

function authOptions(accessToken: string | null | undefined): { useAnonKey?: boolean; accessToken?: string } {
  if (!accessToken) return {};
  return { useAnonKey: true, accessToken };
}

export function createContentAdminRepository(): ContentAdminRepository {
  return {
    async listBlogs(input, accessToken) {
      const result = await callRpc(
        "admin_list_blogs",
        {
          p_status: input.status || null,
          p_q: input.search || null,
          p_limit: input.limit,
          p_offset: input.offset,
        },
        authOptions(accessToken),
      );
      return (result || { rows: [], count: 0 }) as JsonObject;
    },

    async upsertBlog(input, accessToken) {
      return (await callRpc(
        "admin_upsert_blog_v2",
        {
          p_blog_id: input.blogId ?? null,
          p_category_slug: input.categorySlug ?? null,
          p_slug: input.slug ?? null,
          p_title: input.title ?? null,
          p_excerpt: input.excerpt ?? null,
          p_content: input.content ?? null,
          p_content_html: input.contentHtml ?? null,
          p_image_url: input.imageUrl ?? null,
          p_author: input.author ?? null,
          p_read_minutes: input.readMinutes ?? null,
          p_is_featured: input.isFeatured ?? null,
          p_status: input.status ?? null,
          p_meta_title: input.metaTitle ?? null,
          p_meta_description: input.metaDescription ?? null,
          p_canonical_url: input.canonicalUrl ?? null,
          p_og_image_url: input.ogImageUrl ?? null,
          p_tags: input.tags ?? [],
          p_product_ids: input.productIds ?? [],
          p_expected_version: input.expectedVersion ?? null,
          p_ip_address: input.ipAddress ?? null,
        },
        authOptions(accessToken),
      )) as JsonObject;
    },
  };
}
