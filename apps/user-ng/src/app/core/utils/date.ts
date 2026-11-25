const ISO_OR_PG_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})(?:[T\s]+(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(z|Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/**
 * Strictly parses a Postgres naive timestamp or ISO-8601 string as UTC.
 * Normalizes leading/trailing whitespace, space separators, lowercase `z`, and `+HH`/`+HHMM` offsets.
 */
export function parseApiDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  const match = ISO_OR_PG_TIMESTAMP_RE.exec(trimmed);
  if (!match) {
    const fallback = new Date(trimmed);
    return Number.isFinite(fallback.getTime()) ? fallback : null;
  }

  const [, datePart, timePart, rawTz] = match;
  if (!timePart) {
    const parsed = new Date(`${datePart}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  let tz = 'Z';
  if (rawTz) {
    if (rawTz === 'z' || rawTz === 'Z') {
      tz = 'Z';
    } else if (/^[+-]\d{2}$/.test(rawTz)) {
      tz = `${rawTz}:00`;
    } else if (/^[+-]\d{4}$/.test(rawTz)) {
      tz = `${rawTz.slice(0, 3)}:${rawTz.slice(3)}`;
    } else {
      tz = rawTz;
    }
  }

  const parsed = new Date(`${datePart}T${timePart}${tz}`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

const VN_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour12: false,
});

const VN_DEADLINE_FORMATTER = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  hour: '2-digit',
  minute: '2-digit',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour12: false,
});

function formatParts(formatter: Intl.DateTimeFormat, date: Date, includeSeconds: boolean): string {
  const parts = formatter.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value || '';
  const time = includeSeconds
    ? `${pick('hour')}:${pick('minute')}:${pick('second')}`
    : `${pick('hour')}:${pick('minute')}`;
  return `${time} ${pick('day')}/${pick('month')}/${pick('year')}`;
}

/**
 * Formats an API timestamp in Vietnam time (`Asia/Ho_Chi_Minh`), returning `fallback` when missing/invalid.
 */
export function formatVietnamDateTime(value: string | Date | null | undefined, fallback = 'Chưa có'): string {
  const parsed = parseApiDate(value);
  return parsed ? formatParts(VN_DATE_TIME_FORMATTER, parsed, true) : fallback;
}

/**
 * Formats an API deadline without seconds in Vietnam time (`HH:mm dd/MM/yyyy`).
 */
export function formatVietnamDeadline(value: string | Date | null | undefined): string | null {
  const parsed = parseApiDate(value);
  return parsed ? formatParts(VN_DEADLINE_FORMATTER, parsed, false) : null;
}
