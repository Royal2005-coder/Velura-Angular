import type { AdminBlogInput } from './admin-erp-api.service';
import { slugifyProductText } from './admin-erp-catalog';
import { blogEditorText, sanitizeEditorHtml } from './admin-erp-blog-html';

/**
 * Quy tắc CMS của Velura, mirrors `admin_upsert_blog` trong migration 078.
 *
 * RPC vẫn là nơi quyết định; bảng luật này tồn tại để người biên tập nhìn thấy chính xác
 * điều kiện bị chặn trước khi gửi, thay vì nhận một lỗi 422 không rõ từ server.
 */

export const CONTENT_STATUSES = ['draft', 'published', 'archived'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const CONTENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: 'Bản nháp',
  published: 'Đã công bố',
  archived: 'Đã lưu trữ',
};

const CONTENT_STATUS_TONES: Readonly<Record<string, 'neutral' | 'success' | 'warning'>> = {
  draft: 'neutral',
  published: 'success',
  archived: 'warning',
};

/** Cùng khuôn với `^[a-z0-9][a-z0-9-]{1,119}$` trong RPC. */
export const BLOG_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,119}$/;
export const BLOG_TITLE_MIN = 4;
export const BLOG_TITLE_MAX = 180;
export const BLOG_CONTENT_MIN = 40;
export const BLOG_EXCERPT_MAX = 500;
export const BLOG_CONTENT_MAX = 1_000_000;
export const BLOG_READ_MINUTES_MIN = 1;
export const BLOG_READ_MINUTES_MAX = 60;
export const BLOG_META_TITLE_MAX = 70;
export const BLOG_META_DESCRIPTION_MAX = 320;
export const BLOG_TAGS_MAX = 20;
export const BLOG_PRODUCTS_MAX = 30;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bảng chuyển trạng thái nội dung. Bài đã lưu trữ chỉ quay về nháp được, nên muốn công bố
 * lại phải sửa rồi công bố — thêm một lần kiểm tra trước khi bài hiện ra trên website.
 */
export const BLOG_TRANSITIONS: Readonly<Record<ContentStatus, readonly ContentStatus[]>> = {
  draft: ['published', 'archived'],
  published: ['draft', 'archived'],
  archived: ['draft'],
};

/** Ảnh đại diện: chỉ link ngoài https hoặc tài sản của chính hệ thống. */
export const BLOG_IMAGE_PATTERN = /^(https:\/\/|\/assets\/)/;

/** Trạng thái khả dụng cho một form: bài mới chỉ là nháp/công bố, bài cũ theo bảng chuyển. */
export function blogStatusChoices(status: string | undefined, creating: boolean): ContentStatus[] {
  if (creating) {
    return ['draft', 'published'];
  }
  const current = status as ContentStatus | undefined;
  if (!current || !BLOG_TRANSITIONS[current]) {
    return [CONTENT_STATUSES[0]];
  }
  return [current, ...BLOG_TRANSITIONS[current]];
}

export function blogStatusLabel(status: string | undefined): string {
  return CONTENT_STATUS_LABELS[status || ''] || status || '—';
}

export function blogStatusTone(status: string | undefined): 'neutral' | 'success' | 'warning' {
  return CONTENT_STATUS_TONES[status || ''] || 'neutral';
}

/** Bản nháp của trình soạn: một chỗ duy nhất, để validation và body gửi đi không lệch nhau. */
export interface BlogDraft {
  readonly slug: string;
  readonly title: string;
  readonly categorySlug: string;
  readonly status: string;
  readonly excerpt: string;
  readonly content: string;
  readonly contentHtml: string;
  readonly imageUrl: string;
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly canonicalUrl: string;
  readonly ogImageUrl: string;
  readonly tags: string;
  readonly productIds: readonly string[];
  readonly author: string;
  readonly readMinutes: number;
  readonly isFeatured: boolean;
}

export const emptyBlogDraft: BlogDraft = {
  slug: '',
  title: '',
  categorySlug: '',
  status: 'draft',
  excerpt: '',
  content: '',
  contentHtml: '',
  imageUrl: '',
  metaTitle: '',
  metaDescription: '',
  canonicalUrl: '',
  ogImageUrl: '',
  tags: '',
  productIds: [],
  author: 'Velura Editorial',
  readMinutes: 5,
  isFeatured: false,
};

/**
 * Đổi tiêu đề thành slug ASCII, cắt theo trần 120 ký tự của RPC.
 */
export function blogSlugFromTitle(title: string): string {
  return slugifyProductText(title).slice(0, 120);
}

/**
 * Kiểm bản nháp theo đúng bộ luật server đang áp dụng. Trả về lỗi theo từng trường, rỗng khi hợp lệ.
 */
export function validateBlogDraft(draft: BlogDraft, editing: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  const slug = draft.slug.trim().toLowerCase();
  const title = draft.title.trim();
  const html = sanitizeEditorHtml(draft.contentHtml);
  const content = (html ? blogEditorText(html) : draft.content.trim());
  const tags = blogTags(draft.tags);

  if (!BLOG_SLUG_PATTERN.test(slug)) {
    errors['slug'] = 'Slug viết thường, không dấu, không khoảng trắng; 2–120 ký tự, chỉ chữ/số/dấu gạch nối.';
  }
  if (title.length < BLOG_TITLE_MIN || title.length > BLOG_TITLE_MAX) {
    errors['title'] = `Tiêu đề cần ${BLOG_TITLE_MIN}–${BLOG_TITLE_MAX} ký tự.`;
  }
  if (!draft.categorySlug.trim()) {
    errors['categorySlug'] = 'Chọn danh mục cho bài viết.';
  }
  if (content.length < BLOG_CONTENT_MIN) {
    errors['content'] = `Nội dung cần tối thiểu ${BLOG_CONTENT_MIN} ký tự.`;
  }
  if (html.length > BLOG_CONTENT_MAX) {
    errors['content'] = 'Nội dung bài viết tối đa 1.000.000 ký tự.';
  }
  if (draft.excerpt.length > BLOG_EXCERPT_MAX) {
    errors['excerpt'] = `Mô tả ngắn tối đa ${BLOG_EXCERPT_MAX} ký tự.`;
  }
  if (draft.imageUrl && !BLOG_IMAGE_PATTERN.test(draft.imageUrl.trim())) {
    errors['imageUrl'] = 'Ảnh phải là link https:// hoặc đường dẫn /assets/ của hệ thống.';
  }
  if (draft.metaTitle.trim().length > BLOG_META_TITLE_MAX) {
    errors['metaTitle'] = `Meta title tối đa ${BLOG_META_TITLE_MAX} ký tự.`;
  }
  if (draft.metaDescription.trim().length > BLOG_META_DESCRIPTION_MAX) {
    errors['metaDescription'] = `Meta description tối đa ${BLOG_META_DESCRIPTION_MAX} ký tự.`;
  }
  if (draft.canonicalUrl.trim() && !/^https:\/\/[^\s]+$/i.test(draft.canonicalUrl.trim())) {
    errors['canonicalUrl'] = 'Canonical phải là URL https:// đầy đủ.';
  }
  if (draft.ogImageUrl.trim() && !BLOG_IMAGE_PATTERN.test(draft.ogImageUrl.trim())) {
    errors['ogImageUrl'] = 'Ảnh OG phải là link https:// hoặc /assets/ của hệ thống.';
  }
  if (tags.length > BLOG_TAGS_MAX) {
    errors['tags'] = `Tối đa ${BLOG_TAGS_MAX} tag.`;
  }
  if (draft.productIds.length > BLOG_PRODUCTS_MAX) {
    errors['productIds'] = `Tối đa ${BLOG_PRODUCTS_MAX} sản phẩm đính kèm.`;
  }
  if (draft.productIds.some((id) => !UUID_PATTERN.test(id))) {
    errors['productIds'] = 'Có sản phẩm đính kèm không hợp lệ. Gỡ rồi chọn lại.';
  }
  if (draft.readMinutes < BLOG_READ_MINUTES_MIN || draft.readMinutes > BLOG_READ_MINUTES_MAX) {
    errors['readMinutes'] = `Thời gian đọc từ ${BLOG_READ_MINUTES_MIN} đến ${BLOG_READ_MINUTES_MAX} phút.`;
  }
  if (!editing && draft.status === 'archived') {
    errors['status'] = 'Bài mới chỉ lưu được ở bản nháp hoặc công bố.';
  }
  return errors;
}

/** Comma/newline separated tag input; trimmed, deduplicated and bounded like the RPC. */
export function blogTags(value: string): string[] {
  const seen = new Set<string>();
  for (const raw of value.split(/[,\n]/)) {
    const tag = raw.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (tag) seen.add(tag);
  }
  return Array.from(seen).slice(0, BLOG_TAGS_MAX);
}

/**
 * Chuyển bản nháp thành body API, dùng lại đúng tên field RPC mong đợi.
 */
export function blogRequestBody(draft: BlogDraft, expectedVersion?: number): AdminBlogInput {
  const contentHtml = sanitizeEditorHtml(draft.contentHtml);
  return {
    slug: draft.slug.trim().toLowerCase(),
    title: draft.title.trim(),
    categorySlug: draft.categorySlug.trim(),
    status: draft.status,
    excerpt: draft.excerpt,
    content: (contentHtml ? blogEditorText(contentHtml) : draft.content).trim(),
    contentHtml,
    imageUrl: draft.imageUrl.trim() || null,
    metaTitle: draft.metaTitle.trim(),
    metaDescription: draft.metaDescription.trim(),
    canonicalUrl: draft.canonicalUrl.trim(),
    ogImageUrl: draft.ogImageUrl.trim(),
    tags: blogTags(draft.tags),
    productIds: [...draft.productIds],
    author: draft.author.trim() || 'Velura Editorial',
    readMinutes: draft.readMinutes,
    isFeatured: draft.isFeatured,
    ...(expectedVersion == null ? {} : { expectedVersion }),
  };
}
