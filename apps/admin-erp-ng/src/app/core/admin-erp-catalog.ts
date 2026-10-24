/**
 * Catalog rules the API enforces, mirrored here so the operator sees a message before
 * a request is sent. Every constant copies the value in `apps/api/src/products`;
 * the server stays the authority and its validation error remains the fallback.
 */
import { AdminProductVariant, AdminProductVariantInput } from './admin-erp-api.service';
import { AdminTone } from './admin-erp-status-labels';

/** Shown inline and on submit when a product or variant SKU already exists; mirrors the API `SKU_DUPLICATE` message. */
export const SKU_DUPLICATE_MESSAGE = 'Mã SKU đã tồn tại, SKU phải là duy nhất trên toàn hệ thống';

/** Shown when a typed SKU does not match the catalog format. */
export const SKU_FORMAT_MESSAGE = 'SKU phải dạng VL-AO001 hoặc VLR-DV006 (chữ in hoa, có gạch ngang)';

/** Catalog SKU pattern, identical to the API `SKU_PATTERN`. */
export const SKU_PATTERN = /^[A-Z]{2,6}-[A-Z0-9]{2,20}(-[A-Z0-9]{1,10})*$/;

/** Product statuses accepted by the catalog state machine. */
export const PRODUCT_STATUSES = ['on_sale', 'hidden', 'out_of_stock', 'discontinued'] as const;

export const PRODUCT_STATUS_LABELS: Readonly<Record<string, string>> = {
  on_sale: 'Đang bán',
  hidden: 'Tạm ẩn',
  out_of_stock: 'Hết hàng',
  discontinued: 'Ngừng kinh doanh',
};

const PRODUCT_STATUS_TONES: Readonly<Record<string, AdminTone>> = {
  on_sale: 'success',
  hidden: 'warning',
  out_of_stock: 'danger',
  discontinued: 'neutral',
};

/** Operator-facing consequence of each transition, mirroring the API transition table. */
export const PRODUCT_STATUS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  on_sale: ['hidden', 'out_of_stock', 'discontinued'],
  hidden: ['on_sale', 'out_of_stock', 'discontinued'],
  out_of_stock: ['on_sale', 'hidden', 'discontinued'],
  discontinued: ['on_sale', 'hidden', 'out_of_stock'],
};

export const PRODUCT_STATUS_HINTS: Readonly<Record<string, string>> = {
  on_sale: 'Hiện lại trên storefront, cần có ảnh chính',
  hidden: 'Ẩn khỏi storefront, giữ dữ liệu đơn cũ',
  out_of_stock: 'Hết hàng, khách không đặt được',
  discontinued: 'Xóa mềm / ngừng kinh doanh',
};

/** Statuses allowed for a brand-new product; the API rejects the other two on create. */
export const CREATE_STATUSES = ['on_sale', 'hidden'] as const;

/** Product audit action types accepted by the audit endpoint. */
export const PRODUCT_AUDIT_ACTION_TYPES = ['CREATE', 'UPDATE', 'UPDATE_STATUS', 'UPDATE_STOCK'] as const;

/** Operator reason length required by the API for stock and status writes. */
export const MIN_CHANGE_REASON_LENGTH = 10;

/** `validateImageUrls` cap: the first entry is always the primary image. */
export const MAX_PRODUCT_IMAGES = 20;

/** `parseCsv` rejects files with more data rows than this. */
export const MAX_CSV_ROWS = 500;

/** Columns the import API requires; the rest of the template is optional metadata. */
export const CSV_REQUIRED_COLUMNS = ['sku', 'name', 'base_price', 'category_id'] as const;

/**
 * Sort options accepted by `parseListFilters`, labelled for the list toolbar.
 */
export const PRODUCT_ORDER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'updated_at.desc', label: 'Mới cập nhật' },
  { value: 'created_at.desc', label: 'Mới tạo' },
  { value: 'name.asc', label: 'Tên A → Z' },
  { value: 'name.desc', label: 'Tên Z → A' },
  { value: 'sale_price.asc', label: 'Giá bán thấp → cao' },
  { value: 'sale_price.desc', label: 'Giá bán cao → thấp' },
];

/**
 * Vietnamese label for a catalog status, preserving unknown backend codes.
 */
export function productStatusLabel(status: string | null | undefined): string {
  const key = String(status || '');
  if (!key) {
    return '—';
  }
  return PRODUCT_STATUS_LABELS[key] || key;
}

/**
 * Badge tone for a catalog status.
 */
export function productStatusTone(status: string | null | undefined): AdminTone {
  return PRODUCT_STATUS_TONES[String(status || '')] || 'neutral';
}

/**
 * Statuses the product can move to now; an unknown status can only be hidden, like the API default.
 */
export function allowedStatusTransitions(status: string | null | undefined): readonly string[] {
  return PRODUCT_STATUS_TRANSITIONS[String(status || '')] || ['hidden'];
}

/**
 * Returns the normalized SKUs used more than once in one form (trimmed, case-insensitive),
 * so duplicate variant SKUs are flagged before any request reaches the server.
 */
export function duplicateSkus(skus: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const raw of skus) {
    const sku = raw.trim().toUpperCase();
    if (!sku) {
      continue;
    }
    if (seen.has(sku)) {
      duplicates.add(sku);
    }
    seen.add(sku);
  }
  return [...duplicates];
}

/**
 * Builds a URL slug the API accepts: lowercase alphanumerics joined by single dashes.
 */
export function slugifyProductText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 255);
}

/**
 * Strips diacritics and punctuation from a color name to build a stable SKU segment.
 */
export function normalizeColorCode(color: string): string {
  const code = color
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
  return code || 'COLOR';
}

/**
 * Suggests a swatch hex for a typed color name so the variant matrix renders without a color picker.
 */
export function guessColorHex(color: string): string {
  const norm = color.trim().toLowerCase();
  if (norm.includes('đen') || norm.includes('black')) return '#1A1A1A';
  if (norm.includes('đỏ') || norm.includes('red') || norm.includes('ruby')) return '#9B111E';
  if (norm.includes('trắng') || norm.includes('white')) return '#FFFFFF';
  if (norm.includes('xanh lam') || norm.includes('xanh dương') || norm.includes('blue')) return '#1E3A8A';
  if (norm.includes('xanh lá') || norm.includes('green')) return '#15803D';
  if (norm.includes('vàng') || norm.includes('yellow')) return '#EAB308';
  if (norm.includes('hồng') || norm.includes('pink')) return '#EC4899';
  if (norm.includes('be') || norm.includes('kem') || norm.includes('beige')) return '#F5F5DC';
  if (norm.includes('nâu') || norm.includes('brown')) return '#78350F';
  if (norm.includes('tím') || norm.includes('purple')) return '#7E22CE';
  if (norm.includes('cam') || norm.includes('orange')) return '#EA580C';
  if (norm.includes('xám') || norm.includes('ghi') || norm.includes('gray')) return '#6B7280';
  return '#4A4039';
}

/**
 * Expands a color × size list into the variant matrix the create endpoint expects.
 * Each line carries its own SKU so an operator can edit a single combination.
 */
export function buildVariantMatrix(
  baseSku: string,
  colors: readonly string[],
  sizes: readonly string[],
  openingStock = 10,
  threshold = 5,
): AdminProductVariantInput[] {
  const parent = baseSku.trim().toUpperCase();
  const rows: AdminProductVariantInput[] = [];
  for (const color of colors.map((value) => value.trim()).filter(Boolean)) {
    for (const size of sizes.map((value) => value.trim().toUpperCase()).filter(Boolean)) {
      rows.push({
        sku: `${parent}-${normalizeColorCode(color)}-${size}`,
        color,
        colorHex: guessColorHex(color),
        size,
        stockQuantity: openingStock,
        lowStockThreshold: threshold,
      });
    }
  }
  return rows;
}

/**
 * Splits a "Đen, Đỏ Ruby" style list into trimmed, non-empty values.
 */
export function parseListInput(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * On-hand stock of a product, summed across its variants.
 */
export function variantStockTotal(variants: readonly AdminProductVariant[] | undefined): number {
  return (variants || []).reduce((sum, variant) => sum + Number(variant.stock_quantity || 0), 0);
}

/**
 * Variants at or below their own low-stock threshold; drives the "Sắp hết" badge and the bulk sheet.
 */
export function lowStockVariants(variants: readonly AdminProductVariant[] | undefined): AdminProductVariant[] {
  return (variants || []).filter(
    (variant) => Number(variant.stock_quantity ?? 0) <= Number(variant.low_stock_threshold ?? 5),
  );
}

/**
 * Signed delta for one stock adjustment; `set` converts a target quantity into the delta the API wants.
 */
export function stockDelta(type: 'in' | 'out' | 'set', current: number, quantity: number): number {
  if (type === 'in') {
    return Math.trunc(quantity);
  }
  if (type === 'out') {
    return -Math.trunc(quantity);
  }
  return Math.trunc(quantity) - Math.trunc(current);
}

/**
 * Resolves the color swatch of a gallery image, or `null` when the image is a common shot.
 */
export function imageColorOf(imageColors: Record<string, string> | undefined, url: string): string | null {
  return imageColors?.[url] || null;
}

/**
 * Rewrites the color assignment and quality score when one URL replaces another in the gallery.
 */
export function moveImageKey<TValue>(
  map: Record<string, TValue>,
  previousUrl: string | undefined,
  nextUrl: string | null,
  value: TValue | null,
): Record<string, TValue> {
  const next = { ...map };
  if (previousUrl) {
    delete next[previousUrl];
  }
  if (nextUrl && value !== null) {
    next[nextUrl] = value;
  }
  return next;
}
