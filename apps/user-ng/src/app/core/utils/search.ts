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

/**
 * Checks that a text contains the whole typed phrase, or every unaccented word of it.
 * Unlike {@link matchesSearchText} a phrase such as `Premium Cotton 100%` does not match a
 * product that only shares the word `cotton`: a renamed product must not be found by words
 * that only its previous name contained. Special characters such as `%` carry no meaning.
 */
export function matchesAllSearchWords(target: string | undefined | null, query: string): boolean {
  if (!target || !query.trim()) return false;
  if (target.toLowerCase().includes(query.trim().toLowerCase())) return true;
  const words = normalizeSearchText(query).split(' ').filter(Boolean);
  if (!words.length) return false;
  const normTarget = normalizeSearchText(target);
  return words.every((word) => normTarget.includes(word));
}
