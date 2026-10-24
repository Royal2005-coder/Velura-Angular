/**
 * Display helpers shared by ERP admin workspaces. Values are formatted in the same
 * locale/timezone as the existing admin so operators see one set of numbers.
 */

/**
 * Formats an ISO timestamp as Vietnam time. Timezone-less database timestamps are
 * treated as UTC, matching the API contract.
 */
export function adminDateTime(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = new Date(asUtcIso(value));
  return Number.isNaN(parsed.getTime())
    ? '—'
    : new Intl.DateTimeFormat('vi-VN', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: 'Asia/Ho_Chi_Minh',
      }).format(parsed);
}

/**
 * Formats VND with the Vietnamese thousands separator.
 */
export function adminMoney(value: number | null | undefined): string {
  return `${Number(value || 0).toLocaleString('vi-VN')}đ`;
}

/**
 * Formats large money values compactly for KPI cards.
 */
export function adminCompactMoney(value: number | null | undefined): string {
  const amount = Number(value || 0);
  const abs = Math.abs(amount);
  if (abs >= 1e9) {
    return `${(amount / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  }
  if (abs >= 1e6) {
    return `${(amount / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (abs >= 1e3) {
    return `${Math.round(amount / 1e3)}K`;
  }
  return String(amount);
}

/**
 * Builds two-letter initials from a person name, never from a URL.
 */
export function adminInitials(value: string | null | undefined, fallback = 'ERP'): string {
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
 * Counts words for the account/action reason policy.
 */
export function adminWordCount(value: string | null | undefined): number {
  const text = String(value || '').trim();
  return text ? text.split(/\s+/u).filter(Boolean).length : 0;
}

/**
 * Star label used by the review moderation queue.
 */
export function adminStars(value: number | null | undefined): string {
  const rating = Math.max(0, Math.min(5, Number(value || 0)));
  return `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} ${rating}/5`;
}

function asUtcIso(value: string): string {
  const text = String(value).trim();
  if (!text.includes('T') && !text.includes(' ')) return text;
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) return text;
  return `${text.replace(' ', 'T')}Z`;
}
