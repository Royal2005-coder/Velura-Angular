/**
 * Operator search across admin queues: case, Vietnamese diacritics and the letter `đ` are
 * ignored so "giao duc" finds "giáo dục" and "tui" finds "túi". PostgREST `ilike` compares
 * raw codepoints, so folding runs here instead of in SQL.
 */
export function searchFold(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

/** True when the folded needle appears in at least one haystack value. Empty query matches all. */
export function searchMatches(needle: string, ...haystack: unknown[]): boolean {
  const folded = searchFold(needle);
  if (!folded) return true;
  return haystack.some((value) => searchFold(value).includes(folded));
}

/**
 * Upper bound of rows read when a query needs the in-memory fold. It is a real cap: when the
 * scan fills it, the reported count is a floor and older rows are not searched.
 */
export const SEARCH_SCAN_LIMIT = 1000;
