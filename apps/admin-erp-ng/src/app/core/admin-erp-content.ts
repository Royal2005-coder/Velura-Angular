import { environment } from '../../environments/environment';
import type { AdminBannerRow, AdminBlogInput, AdminCollectionRow } from './admin-erp-api.service';
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
 * Đổi tiêu đề thành slug ASCII, cắt theo trần 120 ký tự của RPC và gỡ dấu gạch nối thừa ở cuối.
 */
export function blogSlugFromTitle(title: string): string {
  return slugifyProductText(title).slice(0, 120).replace(/-+$/g, '');
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

// ---------------------------------------------------------------------------
// Banner & collection CMS rules (KAN-116). Mirror `apps/api/src/{banners,collections}` validation so
// the operator sees the exact refusal before sending; the API stays the authority.
// ---------------------------------------------------------------------------

/** Longest stored image/link URL, same ceiling as the API (FR-S3). */
export const CMS_URL_MAX = 500;
/** Longest stored `category_link` on a collection (`collection-service.ts` enforces 255). */
export const CMS_COLLECTION_LINK_MAX = 255;
/** Homepage runway always shows exactly five collections' models. */
export const HOME_MODEL_SLOTS = 5;
/** `/collections` hero strip holds exactly five cutouts when `hero_mode = 'models'`. */
export const COLLECTION_MODEL_SLOTS = 5;
/** Maximum combo/set cards a collection can pin. */
export const COLLECTION_COMBO_MAX = 10;
/** `sort_order` / `home_sort_order` bounds. */
export const CMS_SORT_MAX = 9999;
const GRADIENT_PATTERN = /^linear-gradient\([^;{}]{1,300}\)$/;
const COLLECTION_CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Per-field length ceilings for the collection form (FR-2..FR-4). */
export const COLLECTION_FIELD_LIMITS = {
  name: 80,
  code: 60,
  home_story: 160,
  story_desc: 600,
  kicker: 60,
  story_headline: 120,
  explore_cta: 40,
  products_sub: 40,
  products_title: 80,
  closing_quote: 200,
  script: 40,
  col_number: 60,
  badge: 30,
} as const;
export type CollectionLimitedField = keyof typeof COLLECTION_FIELD_LIMITS;

/** Per-field length ceilings for the banner form (FR-19). */
export const BANNER_FIELD_LIMITS = { title: 120, subtitle: 240, button_text: 40 } as const;

/**
 * Resolves a CMS image path against the storefront origin. `/assets/...` files live on the storefront,
 * not on the admin origin, so a bare relative path 404s here. `http(s)://`, `data:` and anything else pass through.
 */
export function resolveStorefrontAsset(url: string | null | undefined, origin: string = environment.storefrontUrl): string {
  const value = String(url ?? '').trim();
  if (!value) return '';
  if (value.startsWith('/') && !value.startsWith('//')) {
    return `${origin.replace(/\/+$/, '')}${value}`;
  }
  return value;
}

/**
 * Sinh mã định danh (slug) bộ sưu tập từ tên tiếng Việt, cắt tối đa 60 ký tự và loại bỏ dấu `-` thừa ở cuối.
 */
export function collectionCodeFromName(name: string): string {
  return slugifyProductText(name).slice(0, COLLECTION_FIELD_LIMITS.code).replace(/-+$/g, '');
}

/**
 * Chuẩn hóa thông số kéo/cắt khung ảnh (`posX`, `posY`, `zoom`) đồng nhất 1:1 giữa Admin ERP và Storefront.
 */
export function computeMediaFraming(
  rawX: unknown,
  rawY: unknown,
  rawZoom: unknown,
  defaultY: number,
): { posX: number; posY: number; zoom: number; objectPosition: string; transformOrigin: string; transform: string | null } {
  const clamp = (val: unknown, fallback: number, min: number, max: number, factor: number): number =>
    typeof val === 'number' && Number.isFinite(val)
      ? Math.round(Math.min(max, Math.max(min, val)) * factor) / factor
      : fallback;
  const posX = clamp(rawX, 50, 0, 100, 10);
  const posY = clamp(rawY, defaultY, 0, 100, 10);
  const zoom = clamp(rawZoom, 1, 1, 2.4, 100);
  const pos = `${posX}% ${posY}%`;
  return {
    posX,
    posY,
    zoom,
    objectPosition: pos,
    transformOrigin: pos,
    transform: zoom > 1.001 ? `scale(${zoom})` : null,
  };
}

/** Link target the storefront may follow: empty, an in-site path (`/x`, never `//host`) or `https://`. */
export function isCmsLinkUrl(value: string, maxLength: number = CMS_URL_MAX): boolean {
  const text = value.trim();
  if (!text) return true;
  if (text.length > maxLength) return false;
  return (text.startsWith('/') && !text.startsWith('//')) || text.startsWith('https://');
}

/** Stored image URL: `https://…` (any host) or a storefront `/assets/…` path (FR-S3). Blank is "no image". */
export function isCmsMediaUrl(value: string): boolean {
  const text = value.trim();
  if (!text) return true;
  return text.length <= CMS_URL_MAX && (text.startsWith('https://') || text.startsWith('/assets/'));
}

function isSortOrder(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= CMS_SORT_MAX;
}

/** Banner form check (FR-19). Returns a message per field, empty when valid. */
export function validateBannerDraft(draft: Partial<AdminBannerRow>): Record<string, string> {
  const errors: Record<string, string> = {};
  const title = (draft.title ?? '').trim();
  if (!title) errors['title'] = 'Tiêu đề banner là bắt buộc.';
  else if (title.length > BANNER_FIELD_LIMITS.title) errors['title'] = `Tiêu đề tối đa ${BANNER_FIELD_LIMITS.title} ký tự.`;
  if ((draft.subtitle ?? '').trim().length > BANNER_FIELD_LIMITS.subtitle) errors['subtitle'] = `Phụ đề tối đa ${BANNER_FIELD_LIMITS.subtitle} ký tự.`;
  if ((draft.button_text ?? '').trim().length > BANNER_FIELD_LIMITS.button_text) errors['button_text'] = `Chữ nút bấm tối đa ${BANNER_FIELD_LIMITS.button_text} ký tự.`;
  if (!isCmsLinkUrl(draft.link_url ?? '')) errors['link_url'] = 'Liên kết phải bắt đầu bằng / (trong website) hoặc https://.';
  const media = (draft.media_url ?? '').trim();
  if (!media) errors['media_url'] = 'Hình ảnh hoặc video banner là bắt buộc.';
  else if (!isCmsMediaUrl(media)) errors['media_url'] = 'Đường dẫn media phải là https://… hoặc /assets/… (tối đa 500 ký tự).';
  if (!isCmsMediaUrl(draft.poster_url ?? '')) errors['poster_url'] = 'Ảnh poster phải là https://… hoặc /assets/… (tối đa 500 ký tự).';
  if (!Number.isInteger(draft.sort_order ?? 0) || (draft.sort_order ?? 0) < 0) errors['sort_order'] = 'Thứ tự phải là số nguyên không âm.';
  return errors;
}

/** Body for banner create/update: trimmed, placement pinned to the only live one (D5). */
export function bannerRequestBody(draft: Partial<AdminBannerRow>): Partial<AdminBannerRow> {
  const mediaType = draft.media_type === 'video' ? 'video' : 'image';
  return {
    placement: 'products_hero',
    title: (draft.title ?? '').trim(),
    subtitle: (draft.subtitle ?? '').trim() || null,
    tag_label: (draft.tag_label ?? '').trim() || null,
    media_type: mediaType,
    media_url: (draft.media_url ?? '').trim(),
    poster_url: (draft.poster_url ?? '').trim() || null,
    button_text: (draft.button_text ?? '').trim() || null,
    link_url: (draft.link_url ?? '').trim() || null,
    is_active: draft.is_active !== false,
    sort_order: Number(draft.sort_order ?? 0),
    ...(draft.metadata ? { metadata: draft.metadata } : {}),
  };
}

/** Context the collection form needs from sibling rows to apply cross-row rules. */
export interface CollectionValidationContext {
  /** `true` while editing an existing row (code is then immutable and not re-validated). */
  editing: boolean;
  /** Count of OTHER collections that are `is_active` and `show_on_home`. */
  otherHomeSlotsUsed: number;
}

/** Collection form check mirroring §5.3 (length, URL, gradient, cross-field and slot rules). */
export function validateCollectionDraft(draft: Partial<AdminCollectionRow>, context: CollectionValidationContext): Record<string, string> {
  const errors: Record<string, string> = {};
  const text = (value: string | null | undefined): string => (value ?? '').trim();
  const labels: Record<CollectionLimitedField, string> = {
    name: 'Tên bộ sưu tập',
    code: 'Mã định danh',
    home_story: 'Mô tả ngắn',
    story_desc: 'Mô tả bên hông chi tiết',
    kicker: 'Kicker',
    story_headline: 'Tiêu đề câu chuyện',
    explore_cta: 'Chữ nút CTA',
    products_sub: 'Dòng phụ cụm sản phẩm',
    products_title: 'Tiêu đề cụm sản phẩm',
    closing_quote: 'Trích dẫn',
    script: 'Chữ ký nghệ thuật',
    col_number: 'Kỳ / phiên bản',
    badge: 'Badge',
  };
  for (const field of Object.keys(COLLECTION_FIELD_LIMITS) as CollectionLimitedField[]) {
    if (text(draft[field]).length > COLLECTION_FIELD_LIMITS[field]) {
      errors[field] = `${labels[field]} tối đa ${COLLECTION_FIELD_LIMITS[field]} ký tự.`;
    }
  }
  if (!text(draft.name)) errors['name'] = 'Tên bộ sưu tập là bắt buộc.';
  if (!text(draft.story_desc)) errors['story_desc'] = 'Mô tả bên hông chi tiết là bắt buộc.';
  if (!context.editing) {
    const code = text(draft.code).toLowerCase();
    if (!code) errors['code'] = 'Mã định danh (slug) là bắt buộc.';
    else if (!errors['code'] && !COLLECTION_CODE_PATTERN.test(code)) errors['code'] = 'Mã chỉ gồm chữ thường, số và dấu gạch ngang, ví dụ soft-ceremony.';
  }
  if (!isCmsLinkUrl(draft.category_link ?? '', CMS_COLLECTION_LINK_MAX)) {
    errors['category_link'] = `Đường dẫn phải bắt đầu bằng / (trong website) hoặc https:// (tối đa ${CMS_COLLECTION_LINK_MAX} ký tự).`;
  }
  const gradient = text(draft.hero_gradient);
  if (gradient && !GRADIENT_PATTERN.test(gradient)) errors['hero_gradient'] = 'Gradient phải có dạng linear-gradient(...).';
  if (!isCmsMediaUrl(draft.banner_url ?? '')) errors['banner_url'] = 'Ảnh bìa phải là https://… hoặc /assets/… (tối đa 500 ký tự).';
  if (!isCmsMediaUrl(draft.home_model_url ?? '')) errors['home_model_url'] = 'Ảnh trang chủ phải là https://… hoặc /assets/… (tối đa 500 ký tự).';
  const models = (draft.models ?? []).map((url) => url.trim()).filter(Boolean);
  const slotCount = (draft.models ?? []).length;
  if (slotCount > COLLECTION_MODEL_SLOTS) errors['models'] = `Tối đa ${COLLECTION_MODEL_SLOTS} ảnh người mẫu.`;
  else if (models.some((url) => !isCmsMediaUrl(url))) errors['models'] = 'Ảnh người mẫu phải là https://… hoặc /assets/….';
  if (draft.hero_mode === 'cover' && !text(draft.banner_url)) {
    errors['banner_url'] = 'Chế độ "Ảnh bìa" cần tải ảnh bìa lên.';
  }
  if (draft.is_active !== false && draft.hero_mode !== 'cover' && !errors['models'] && models.length !== COLLECTION_MODEL_SLOTS) {
    errors['models'] = `Bộ sưu tập đang bật ở chế độ 5 người mẫu cần đủ ${COLLECTION_MODEL_SLOTS} ảnh (hiện có ${models.length}). Tải thêm ảnh hoặc tắt kích hoạt.`;
  }
  if (draft.show_on_home) {
    if (!text(draft.home_model_url)) {
      errors['home_model_url'] = 'Bật hiển thị trang chủ cần có ảnh người mẫu trang chủ.';
    }
    if (draft.is_active !== false && context.otherHomeSlotsUsed + 1 > HOME_MODEL_SLOTS) {
      errors['show_on_home'] = `Trang chủ đã đủ ${HOME_MODEL_SLOTS} người mẫu. Hãy tắt một bộ sưu tập khác trước.`;
    }
  }
  if (!isSortOrder(draft.sort_order ?? 0)) errors['sort_order'] = `Thứ tự phải là số nguyên từ 0 đến ${CMS_SORT_MAX}.`;
  if (!isSortOrder(draft.home_sort_order ?? 0)) errors['home_sort_order'] = `Thứ tự trang chủ phải là số nguyên từ 0 đến ${CMS_SORT_MAX}.`;
  if ((draft.product_ids ?? []).length > COLLECTION_COMBO_MAX) errors['product_ids'] = `Tối đa ${COLLECTION_COMBO_MAX} combo/set.`;
  return errors;
}

/** Body for collection create/update (§5.3). `label` is left to the server (= name); `code` is immutable once created. */
export function collectionRequestBody(draft: Partial<AdminCollectionRow>, editing: boolean): Partial<AdminCollectionRow> {
  const text = (value: string | null | undefined): string => (value ?? '').trim();
  const gradient = text(draft.hero_gradient);
  const categoryLink = text(draft.category_link);
  const body: Partial<AdminCollectionRow> = {
    name: text(draft.name),
    col_number: text(draft.col_number),
    script: text(draft.script),
    badge: text(draft.badge),
    ...(gradient ? { hero_gradient: gradient } : editing ? {} : { hero_gradient: '' }),
    banner_url: text(draft.banner_url) || null,
    hero_mode: draft.hero_mode === 'cover' ? 'cover' : 'models',
    models: (draft.models ?? []).map((url) => url.trim()).filter(Boolean).slice(0, COLLECTION_MODEL_SLOTS),
    home_story: text(draft.home_story) || null,
    kicker: text(draft.kicker),
    story_headline: text(draft.story_headline),
    story_desc: text(draft.story_desc),
    explore_cta: text(draft.explore_cta),
    ...(categoryLink ? { category_link: categoryLink } : editing ? {} : { category_link: '' }),
    products_sub: text(draft.products_sub),
    products_title: text(draft.products_title),
    closing_quote: text(draft.closing_quote),
    home_model_url: text(draft.home_model_url) || null,
    show_on_home: Boolean(draft.show_on_home),
    home_sort_order: Number(draft.home_sort_order ?? 0),
    product_ids: [...new Set(draft.product_ids ?? [])].slice(0, COLLECTION_COMBO_MAX),
    is_active: draft.is_active !== false,
    sort_order: Number(draft.sort_order ?? 0),
    ...(draft.styling_metadata && Object.keys(draft.styling_metadata).length > 0
      ? { styling_metadata: draft.styling_metadata }
      : {}),
  };
  if (!editing) body.code = text(draft.code).toLowerCase();
  return body;
}

/** Returns a copy of `list` with the item at `from` moved to `to`; out-of-range moves return the list unchanged. */
export function moveListItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Live state of the homepage runway across all collections, for the "n/5" chip (FR-14). */
export interface HomeRunwaySummary {
  /** Collections that are active, flagged for the homepage and have a model image. */
  count: number;
  /** `true` when the runway is complete (exactly five). */
  complete: boolean;
  /** Active collections flagged for the homepage that are missing their model image. */
  missingModel: string[];
  /** Names sharing a `home_model_url` with another runway collection (E3). */
  duplicateModel: string[];
}

/** Counts the runway the storefront will render and reports what is blocking it. */
export function homeRunwaySummary(collections: readonly Pick<AdminCollectionRow, 'name' | 'is_active' | 'show_on_home' | 'home_model_url'>[]): HomeRunwaySummary {
  const flagged = collections.filter((c) => c.is_active && c.show_on_home);
  const ready = flagged.filter((c) => (c.home_model_url ?? '').trim());
  const urls = ready.map((c) => (c.home_model_url ?? '').trim());
  return {
    count: ready.length,
    complete: ready.length === HOME_MODEL_SLOTS,
    missingModel: flagged.filter((c) => !(c.home_model_url ?? '').trim()).map((c) => c.name),
    duplicateModel: ready.filter((c) => urls.filter((url) => url === (c.home_model_url ?? '').trim()).length > 1).map((c) => c.name),
  };
}
