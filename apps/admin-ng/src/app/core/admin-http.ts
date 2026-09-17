import { HttpErrorResponse } from '@angular/common/http';

export interface AdminListPayload<T> {
  rows?: T[];
  data?: T[];
  count?: number;
}

/**
 * Reads remaining attempts / lock expiry from the API error envelope.
 */
export function adminAuthLockout(error: unknown): {
  code: string;
  remainingAttempts: number | null;
  lockedUntil: string | null;
  retryAfterSeconds: number;
} | null {
  if (!(error instanceof HttpErrorResponse)) {
    return null;
  }
  const payload = error.error as {
    error?: { code?: string; details?: { remaining_attempts?: number; locked_until?: string | null; retry_after_seconds?: number } };
  } | null;
  const details = payload?.error?.details;
  const code = payload?.error?.code || '';
  if (!details && code !== 'LOCKED') {
    return null;
  }
  return {
    code: code || (error.status === 403 ? 'LOCKED' : 'UNAUTHORIZED'),
    remainingAttempts: typeof details?.remaining_attempts === 'number' ? details.remaining_attempts : null,
    lockedUntil: details?.locked_until || null,
    retryAfterSeconds: Number(details?.retry_after_seconds) || 0,
  };
}

/**
 * Reads the original admin API error envelope (`error.message`).
 */
export function adminErrorMessage(error: unknown, fallback = 'Không thể gọi API quản trị.'): string {
  if (error instanceof HttpErrorResponse) {
    const payload = error.error as {
      error?: { message?: string; details?: unknown } | string;
      error_description?: string;
      msg?: string;
      message?: string;
    } | null;
    const details = typeof payload?.error === 'object' ? payload.error?.details : undefined;
    const detailText = formatErrorDetails(details);
    if (detailText) {
      return detailText;
    }
    if (typeof payload?.error === 'object' && payload.error?.message) {
      return payload.error.message;
    }
    return payload?.error_description || payload?.msg || payload?.message || error.message || fallback;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

/**
 * Flattens `{ field: [message] }` validation details from the admin API.
 */
export function formatErrorDetails(details: unknown): string {
  if (!details || typeof details !== 'object') {
    return '';
  }
  if (Array.isArray(details)) {
    return details
      .map((row) => {
        if (!row || typeof row !== 'object') {
          return String(row);
        }
        const item = row as { row?: number; field?: string; message?: string };
        return [item.row ? `Dòng ${item.row}` : '', item.field, item.message].filter(Boolean).join(' · ');
      })
      .filter(Boolean)
      .join(' | ');
  }
  return Object.entries(details as Record<string, unknown>)
    .flatMap(([field, value]) => {
      const messages = Array.isArray(value) ? value : [value];
      return messages.map((message) => `${field}: ${String(message)}`);
    })
    .join(' · ');
}

/**
 * Unwraps `{ rows }` / `{ data }` list payloads used by vanilla admin modules.
 */
export function adminListRows<T>(payload: AdminListPayload<T> | T[] | null | undefined): T[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload) {
    return [];
  }
  if (Array.isArray(payload.rows)) {
    return payload.rows;
  }
  const nested = payload.data as AdminListPayload<T> | T[] | undefined;
  if (Array.isArray(nested)) {
    return nested;
  }
  if (nested && Array.isArray(nested.rows)) {
    return nested.rows;
  }
  return [];
}

/**
 * Reads the list count when the API sends `count` separately.
 */
export function adminListCount<T>(payload: AdminListPayload<T> | T[] | null | undefined): number {
  if (Array.isArray(payload)) {
    return payload.length;
  }
  if (typeof payload?.count === 'number') {
    return payload.count;
  }
  const nested = payload?.data as AdminListPayload<T> | undefined;
  if (nested && typeof nested.count === 'number') {
    return nested.count;
  }
  return adminListRows(payload).length;
}

/**
 * Converts a 1-based page index into the admin API `offset` query.
 */
export function adminOffset(page: number, pageSize: number): string {
  return String((Math.max(1, page) - 1) * pageSize);
}

/**
 * Builds the original admin footer range label from a server-paged list.
 */
export function adminRangeLabel(total: number, page: number, pageSize: number, noun: string): string {
  if (!total) {
    return `Hiển thị 0 - 0 / 0 ${noun}`;
  }
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return `Hiển thị ${start} - ${end} / ${total} ${noun}`;
}
