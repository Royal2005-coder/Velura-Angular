/**
 * Formats a storefront price using the existing Vietnamese locale.
 */
export function formatVnd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '';
  }
  return `${new Intl.NumberFormat('vi-VN').format(Math.round(value))} đ`;
}

/**
 * Rewrites vanilla `/src/assets` paths so Angular serves them from `/assets`.
 */
export function toPublicAsset(url: string | null | undefined, fallback: string): string {
  if (!url) {
    return fallback;
  }
  return url.replace('/src/assets/', '/assets/');
}
