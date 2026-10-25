import type { AdminBlogInput } from './admin-erp-api.service';
import { slugifyProductText } from './admin-erp-catalog';

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
export const BLOG_READ_MINUTES_MIN = 1;
export const BLOG_READ_MINUTES_MAX = 60;

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
  readonly imageUrl: string;
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
  imageUrl: '',
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
  const content = draft.content.trim();

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
  if (draft.excerpt.length > BLOG_EXCERPT_MAX) {
    errors['excerpt'] = `Mô tả ngắn tối đa ${BLOG_EXCERPT_MAX} ký tự.`;
  }
  if (draft.imageUrl && !BLOG_IMAGE_PATTERN.test(draft.imageUrl.trim())) {
    errors['imageUrl'] = 'Ảnh phải là link https:// hoặc đường dẫn /assets/ của hệ thống.';
  }
  if (draft.readMinutes < BLOG_READ_MINUTES_MIN || draft.readMinutes > BLOG_READ_MINUTES_MAX) {
    errors['readMinutes'] = `Thời gian đọc từ ${BLOG_READ_MINUTES_MIN} đến ${BLOG_READ_MINUTES_MAX} phút.`;
  }
  if (!editing && draft.status === 'archived') {
    errors['status'] = 'Bài mới chỉ lưu được ở bản nháp hoặc công bố.';
  }
  return errors;
}

/**
 * Chuyển bản nháp thành body API, dùng lại đúng tên field RPC mong đợi.
 */
export function blogRequestBody(draft: BlogDraft, expectedVersion?: number): AdminBlogInput {
  return {
    slug: draft.slug.trim().toLowerCase(),
    title: draft.title.trim(),
    categorySlug: draft.categorySlug.trim(),
    status: draft.status,
    excerpt: draft.excerpt,
    content: draft.content,
    imageUrl: draft.imageUrl.trim() || null,
    author: draft.author.trim() || 'Velura Editorial',
    readMinutes: draft.readMinutes,
    isFeatured: draft.isFeatured,
    ...(expectedVersion == null ? {} : { expectedVersion }),
  };
}
