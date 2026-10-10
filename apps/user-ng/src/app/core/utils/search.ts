/**
 * Vietnamese diacritics removal and search text normalization.
 * Enables insensitive matching between accented and unaccented terms (e.g. 'đầm' matches 'dam').
 */
export function normalizeSearchText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks whether a target text contains a search query, matching both original and unaccented variants.
 */
export function matchesSearchText(target: string | undefined | null, query: string): boolean {
  if (!target || !query) return false;
  const rawTarget = target.toLowerCase();
  const rawQuery = query.toLowerCase().trim();
  if (rawTarget.includes(rawQuery)) return true;

  const normTarget = normalizeSearchText(target);
  const normQuery = normalizeSearchText(query);
  if (!normQuery) return false;
  return normTarget.includes(normQuery);
}
