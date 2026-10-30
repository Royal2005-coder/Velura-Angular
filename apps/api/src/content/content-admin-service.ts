import { generateGeminiJson } from "../gemini-client.js";
import { HttpError } from "../http.js";
import { requirePermission } from "../rbac.js";
import { asJsonObject, asString, type AuthContext, type JsonObject, type RequestMeta } from "../types.js";
import { blogPlainText, sanitizeBlogHtml } from "./blog-html.js";
import type { ContentAdminRepository } from "./content-admin-repository.js";

/** Trạng thái nội dung mà migration 078 chấp nhận. */
export const CONTENT_STATUSES = ["draft", "published", "archived"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,119}$/;

/**
 * Mã lỗi do migration 078 `raise sqlstate ... using message`, kèm câu tiếng Việt để frontend
 * hiện đúng hành động cần làm thay vì báo lỗi chung.
 */
const CONTENT_DATABASE_ERRORS: Readonly<Record<string, { status: number; message: string }>> = {
  RBAC_DENIED: { status: 403, message: "Vai trò hiện tại không biên tập được nội dung." },
  BLOG_SLUG_INVALID: { status: 422, message: "Slug phải là chữ thường, không dấu, bắt đầu bằng chữ/số (2–120 ký tự)." },
  BLOG_SLUG_TAKEN: { status: 409, message: "Slug này đã có bài khác dùng. Đổi slug trước khi lưu." },
  BLOG_TITLE_INVALID: { status: 422, message: "Tiêu đề cần từ 4 đến 180 ký tự." },
  BLOG_CATEGORY_REQUIRED: { status: 422, message: "Chọn danh mục cho bài viết." },
  BLOG_CATEGORY_NOT_FOUND: { status: 422, message: "Danh mục không tồn tại trong hệ thống." },
  BLOG_EXCERPT_TOO_LONG: { status: 422, message: "Mô tả ngắn tối đa 500 ký tự." },
  BLOG_CONTENT_TOO_SHORT: { status: 422, message: "Nội dung bài viết cần tối thiểu 40 ký tự." },
  BLOG_IMAGE_URL_INVALID: { status: 422, message: "Ảnh đại diện phải là link https:// hoặc đường dẫn /assets/ của hệ thống." },
  BLOG_META_TITLE_TOO_LONG: { status: 422, message: "Meta title tối đa 70 ký tự." },
  BLOG_META_DESCRIPTION_TOO_LONG: { status: 422, message: "Meta description tối đa 320 ký tự." },
  BLOG_CANONICAL_INVALID: { status: 422, message: "Canonical phải là URL https:// đầy đủ." },
  BLOG_TAGS_TOO_MANY: { status: 422, message: "Tối đa 20 tag cho một bài viết." },
  BLOG_PRODUCTS_TOO_MANY: { status: 422, message: "Tối đa 30 sản phẩm đính kèm." },
  BLOG_PRODUCT_UNAVAILABLE: { status: 422, message: "Có sản phẩm đính kèm đang ẩn hoặc ngừng bán. Gỡ rồi chọn lại." },
  BLOG_READ_MINUTES_INVALID: { status: 422, message: "Thời gian đọc phải từ 1 đến 60 phút." },
  BLOG_STATUS_INVALID: { status: 422, message: "Trạng thái bài viết không hợp lệ." },
  BLOG_CREATE_STATUS_INVALID: { status: 422, message: "Bài mới chỉ lưu được ở bản nháp hoặc công bố; 'đã lưu trữ' dành cho bài từng đăng." },
  BLOG_TRANSITION_DENIED: { status: 422, message: "Không thể chuyển bài sang trạng thái này. Bài đã lưu trữ chỉ quay về bản nháp được." },
  BLOG_NOT_FOUND: { status: 404, message: "Không tìm thấy bài viết." },
  VERSION_CONFLICT: { status: 409, message: "Bài viết vừa được người khác sửa. Tải lại bản mới nhất rồi sửa tiếp." },
};

/**
 * Chuyển lỗi PostgREST của RPC nội dung thành HttpError có mã ổn định và thông điệp tiếng Việt.
 */
export function mapContentDatabaseError(error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;
  const details = asJsonObject(error.details);
  const code = asString(details.message).trim() || error.message.replace(/\s*\[status:\d+\]$/, "").trim();
  const known = CONTENT_DATABASE_ERRORS[code];
  return known ? new HttpError(known.status, code, known.message, error.details) : error;
}

/**
 * Hợp đồng HTTP của một lần biên tập bài viết. Service giữ phần kiểm tra rẻ để frontend nhận
 * 422 ngay; quy tắc cuối vẫn nằm trong RPC, vì đó là nơi duy nhất biết trạng thái hiện tại.
 */
export interface ContentDraftInput {
  readonly slug: string;
  readonly title: string;
  readonly categorySlug: string;
  readonly status: string;
  readonly expectedVersion?: number;
  readonly excerpt?: string;
  readonly content?: string;
  /** `null`/absent means a legacy caller that does not manage rich content or SEO. */
  readonly contentHtml?: string | null;
  readonly imageUrl?: string | null;
  readonly metaTitle?: string;
  readonly metaDescription?: string;
  readonly canonicalUrl?: string;
  readonly ogImageUrl?: string;
  readonly tags?: string[];
  readonly productIds?: string[];
  readonly author?: string;
  readonly readMinutes?: number;
  readonly isFeatured?: boolean;
}

export interface ContentAdminService {
  listBlogs(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<JsonObject>;
  createBlog(context: AuthContext | undefined, body: JsonObject, requestMeta: RequestMeta): Promise<JsonObject>;
  updateBlog(context: AuthContext | undefined, blogId: string, body: JsonObject, requestMeta: RequestMeta): Promise<JsonObject>;
  /** Draft-only AI assistance; never persists or publishes, the editor decides what to accept. */
  suggestSeo(context: AuthContext | undefined, body: JsonObject): Promise<JsonObject>;
}

export function createContentAdminService({ repository, generateJson = generateGeminiJson }: {
  repository: ContentAdminRepository;
  generateJson?: typeof generateGeminiJson;
}): ContentAdminService {
  function integer(value: string | null, fallback: number, max: number): number {
    const parsed = Number.parseInt(value || "", 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, 0), max);
  }

  function validate(input: ContentDraftInput, editing: boolean): void {
    const errors: Record<string, string> = {};
    if (!SLUG_PATTERN.test(input.slug)) errors.slug = CONTENT_DATABASE_ERRORS.BLOG_SLUG_INVALID.message;
    if (input.title.trim().length < 4 || input.title.trim().length > 180) errors.title = CONTENT_DATABASE_ERRORS.BLOG_TITLE_INVALID.message;
    if (!input.categorySlug.trim()) errors.categorySlug = CONTENT_DATABASE_ERRORS.BLOG_CATEGORY_REQUIRED.message;
    if ((input.contentHtml ? blogPlainText(input.contentHtml) : (input.content || "")).length < 40) errors.content = CONTENT_DATABASE_ERRORS.BLOG_CONTENT_TOO_SHORT.message;
    if ((input.contentHtml || "").length > 1_000_000 || (input.content || "").length > 1_000_000) {
      errors.content = "Nội dung bài viết tối đa 1.000.000 ký tự.";
    }
    if ((input.metaTitle || "").trim().length > 70) errors.metaTitle = "Meta title tối đa 70 ký tự.";
    if ((input.metaDescription || "").trim().length > 320) errors.metaDescription = "Meta description tối đa 320 ký tự.";
    if ((input.canonicalUrl || "").trim() && !/^https:\/\/[^\s]+$/i.test((input.canonicalUrl || "").trim())) {
      errors.canonicalUrl = "Canonical phải là URL https:// đầy đủ.";
    }
    if ((input.ogImageUrl || "").trim() && !/^(https:\/\/|\/assets\/)/.test((input.ogImageUrl || "").trim())) {
      errors.ogImageUrl = CONTENT_DATABASE_ERRORS.BLOG_IMAGE_URL_INVALID.message;
    }
    if ((input.tags || []).length > 20) errors.tags = "Tối đa 20 tag.";
    if ((input.productIds || []).length > 30) errors.productIds = "Tối đa 30 sản phẩm đính kèm.";
    if ((input.productIds || []).some((id) => !UUID_PATTERN.test(id))) errors.productIds = "Danh sách sản phẩm đính kèm không hợp lệ.";
    if ((input.excerpt || "").length > 500) errors.excerpt = CONTENT_DATABASE_ERRORS.BLOG_EXCERPT_TOO_LONG.message;
    if (!CONTENT_STATUSES.includes(input.status as ContentStatus)) errors.status = CONTENT_DATABASE_ERRORS.BLOG_STATUS_INVALID.message;
    if (!editing && input.status === "archived") errors.status = CONTENT_DATABASE_ERRORS.BLOG_CREATE_STATUS_INVALID.message;
    if (editing && !Number.isInteger(input.expectedVersion)) errors.expectedVersion = "Thiếu phiên bản bài viết đang sửa.";
    if (Object.keys(errors).length) {
      throw new HttpError(422, "CONTENT_VALIDATION", "Bài viết chưa hợp lệ. Kiểm lại các mục được đánh dấu.", errors);
    }
  }

  function draft(body: JsonObject): ContentDraftInput {
    const contentHtml = body.contentHtml === undefined || body.contentHtml === null
      ? null
      : sanitizeBlogHtml(asString(body.contentHtml));
    return {
      slug: asString(body.slug).toLowerCase().trim(),
      title: asString(body.title),
      categorySlug: asString(body.categorySlug),
      status: asString(body.status) || "draft",
      expectedVersion: body.expectedVersion == null ? undefined : Number(body.expectedVersion),
      excerpt: asString(body.excerpt),
      content: (contentHtml ? blogPlainText(contentHtml) : "") || asString(body.content),
      contentHtml,
      imageUrl: body.imageUrl == null ? null : asString(body.imageUrl),
      metaTitle: asString(body.metaTitle),
      metaDescription: asString(body.metaDescription),
      canonicalUrl: asString(body.canonicalUrl),
      ogImageUrl: asString(body.ogImageUrl),
      tags: Array.isArray(body.tags) ? [...new Set(body.tags.map((tag) => asString(tag).trim().slice(0, 60)).filter(Boolean))] : [],
      productIds: Array.isArray(body.productIds) ? [...new Set(body.productIds.map((id) => asString(id).trim()).filter(Boolean))] : [],
      author: asString(body.author),
      readMinutes: body.readMinutes == null ? undefined : Number(body.readMinutes),
      isFeatured: body.isFeatured == null ? undefined : Boolean(body.isFeatured),
    };
  }

  return {
    async listBlogs(context, searchParams) {
      requirePermission(context as AuthContext, "content", "read");
      return repository.listBlogs(
        {
          status: searchParams.get("status") || "",
          search: (searchParams.get("q") || "").trim(),
          limit: integer(searchParams.get("limit"), 50, 200),
          offset: integer(searchParams.get("offset"), 0, 100000),
        },
        context?.accessToken ?? null,
      );
    },

    async createBlog(context, body, requestMeta) {
      requirePermission(context as AuthContext, "content", "create");
      const input = draft(body);
      validate(input, false);
      try {
        return await repository.upsertBlog({ ...input, blogId: null, ipAddress: requestMeta.ipAddress }, context?.accessToken ?? null);
      } catch (error: unknown) {
        throw mapContentDatabaseError(error);
      }
    },

    async updateBlog(context, blogId, body, requestMeta) {
      requirePermission(context as AuthContext, "content", "update");
      if (!UUID_PATTERN.test(blogId)) {
        throw new HttpError(422, "VALIDATION_ERROR", "blogId phải là uuid", { blogId: ["invalid uuid"] });
      }
      const input = draft(body);
      validate(input, true);
      try {
        return await repository.upsertBlog({ ...input, blogId, ipAddress: requestMeta.ipAddress }, context?.accessToken ?? null);
      } catch (error: unknown) {
        throw mapContentDatabaseError(error);
      }
    },

    async suggestSeo(context, body) {
      requirePermission(context as AuthContext, "content", "update");
      const title = asString(body.title).trim();
      const content = blogPlainText(sanitizeBlogHtml(body.contentHtml ?? body.content)).slice(0, 12000);
      if (title.length < 4 || content.length < 40) {
        throw new HttpError(422, "CONTENT_VALIDATION", "Cần tiêu đề và nội dung bài viết trước khi gợi ý SEO.");
      }
      const result = asJsonObject(await generateJson(
        `Bạn là biên tập SEO cho thời trang Velura. Từ tiêu đề và nội dung dưới đây, tạo metaTitle <= 60 ký tự, metaDescription <= 155 ký tự, 3-6 tag tiếng Việt ngắn và summary 1 câu. Không bịa số liệu, không dùng từ tuyệt đối. Tiêu đề: ${title}
Nội dung: ${content}`,
        { type: "object", additionalProperties: false, required: ["metaTitle", "metaDescription", "tags", "summary"],
          properties: { metaTitle: { type: "string" }, metaDescription: { type: "string" }, tags: { type: "array", items: { type: "string" } }, summary: { type: "string" } } },
        { model: "gemini-3.5-flash-lite", timeoutMs: 30000, maxRetries: 1 }
      ));
      const tags = Array.isArray(result.tags) ? result.tags.map((tag) => asString(tag).trim()).filter(Boolean).slice(0, 6) : [];
      return {
        metaTitle: asString(result.metaTitle).trim().slice(0, 70),
        metaDescription: asString(result.metaDescription).trim().slice(0, 320),
        tags,
        summary: asString(result.summary).trim().slice(0, 500)
      };
    }
  };
}
