import { HttpErrorResponse } from '@angular/common/http';

export interface AdminListPayload<T> {
  rows?: T[];
  data?: T[];
  count?: number;
}

/**
 * Reads the original admin API error envelope (`error.message`).
 */
export function adminErrorMessage(error: unknown, fallback = 'Không thể gọi API quản trị.'): string {
  if (error instanceof HttpErrorResponse) {
    const payload = error.error as {
      error?: { message?: string } | string;
      error_description?: string;
      msg?: string;
      message?: string;
    } | null;
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
 * Unwraps `{ rows }` / `{ data }` list payloads used by vanilla admin modules.
 */
export function adminListRows<T>(payload: AdminListPayload<T> | T[] | null | undefined): T[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload?.rows || payload?.data || [];
}

/**
 * Reads the list count when the API sends `count` separately.
 */
export function adminListCount<T>(payload: AdminListPayload<T> | T[] | null | undefined): number {
  if (Array.isArray(payload)) {
    return payload.length;
  }
  return payload?.count ?? adminListRows(payload).length;
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
