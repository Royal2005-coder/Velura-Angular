/**
 * Shared display helpers copied from the vanilla 5174 admin scripts.
 */

/**
 * Formats an ISO timestamp with the original admin locale.
 */
export function adminDateTime(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? '—'
    : new Intl.DateTimeFormat('vi-VN', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: 'Asia/Ho_Chi_Minh',
      }).format(parsed);
}

/**
 * Formats VND the same way vanilla `admin.js` / `pricing.js` do.
 */
export function adminMoney(value: number | null | undefined): string {
  return `${Number(value || 0).toLocaleString('vi-VN')}đ`;
}

/**
 * Builds two-letter initials from a person name, never from a URL.
 */
export function adminInitials(value: string | null | undefined, fallback = 'KH'): string {
  const text = String(value || '').trim();
  if (!text || adminIsHttpUrl(text)) {
    return fallback;
  }
  const parts = text.split(/\s+/).filter(Boolean);
  const letters = parts.map((word) => word[0]).join('').slice(0, 2).toUpperCase();
  return letters || fallback;
}

/**
 * Whether a stored avatar is a remote image URL.
 */
export function adminIsHttpUrl(value: string | null | undefined): boolean {
  return /^https?:\/\//i.test(String(value || ''));
}

/**
 * Counts words the same way vanilla `countWords` does.
 */
export function adminWordCount(value: string | null | undefined): number {
  const text = String(value || '').trim();
  return text ? text.split(/\s+/u).filter(Boolean).length : 0;
}

/**
 * Star rating label used by vanilla `reviews.js`.
 */
export function adminStars(value: number | null | undefined): string {
  const rating = Math.max(0, Math.min(5, Number(value || 0)));
  return `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} ${rating}/5`;
}

export type AdminPageItem = number | '…';

/**
 * Compact page list used by vanilla logs/accounts (ellipsis after 6 pages).
 */
export function adminPageItems(pageCount: number, current: number): AdminPageItem[] {
  const total = Math.max(1, pageCount);
  const page = Math.min(total, Math.max(1, current));
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const items: AdminPageItem[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(total - 1, page + 1);
  if (start > 2) {
    items.push('…');
  }
  for (let next = start; next <= end; next += 1) {
    items.push(next);
  }
  if (end < total - 1) {
    items.push('…');
  }
  items.push(total);
  return items;
}

/**
 * Sequential page numbers when a compact list is not needed.
 */
export function adminPageNumbers(pageCount: number): number[] {
  return Array.from({ length: Math.max(1, pageCount) }, (_, index) => index + 1);
}
