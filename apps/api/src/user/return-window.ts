/** Days after delivery during which the buyer can open a return (matches the DB RPC and BA policy). */
export const RETURN_WINDOW_DAYS = 7;
export const RETURN_WINDOW_MS = RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const ISO_OR_PG_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})(?:[T\s]+(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(z|Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/**
 * Strictly parses a Postgres timestamp (`YYYY-MM-DD HH:mm:ss[.fff]`) or ISO-8601 string as UTC.
 * Returns `null` for empty, missing, or unparseable values so callers fail closed.
 */
export function parseUtcDateOrNull(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = ISO_OR_PG_TIMESTAMP_RE.exec(trimmed);
  if (!match) return null;

  const [, datePart, timePart, rawTz] = match;
  if (!timePart) {
    const parsed = new Date(`${datePart}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  let tz = "Z";
  if (rawTz) {
    if (rawTz === "z" || rawTz === "Z") {
      tz = "Z";
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

/**
 * Normalizes a Postgres or ISO timestamp string to canonical ISO-8601 UTC (`...Z`), or `null` if invalid/empty.
 */
export function toUtcIsoString(value: unknown): string | null {
  return parseUtcDateOrNull(value)?.toISOString() ?? null;
}

/**
 * Computes the inclusive 7-day return window end timestamp from a valid delivery timestamp.
 */
export function returnWindowDeadline(deliveredAt: Date | null): Date | null {
  if (!deliveredAt || !Number.isFinite(deliveredAt.getTime())) return null;
  return new Date(deliveredAt.getTime() + RETURN_WINDOW_MS);
}

/**
 * True inside the inclusive seven-day window from a valid delivery timestamp.
 * Fails closed (`false`) when `deliveredAt` or `now` is null or invalid.
 */
export function returnWindowOpen(deliveredAt: Date | null, now: Date = new Date()): boolean {
  if (!deliveredAt || !Number.isFinite(deliveredAt.getTime()) || !Number.isFinite(now.getTime())) {
    return false;
  }
  const elapsed = now.getTime() - deliveredAt.getTime();
  return elapsed >= 0 && elapsed <= RETURN_WINDOW_MS;
}
