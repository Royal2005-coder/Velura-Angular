/**
 * Canonical size order for apparel and accessories:
 * XXS -> XS -> S -> M -> L -> XL -> XXL -> 2XL -> 3XL -> 4XL -> 5XL -> FREE SIZE.
 */
export const SIZE_ORDER: readonly string[] = [
  'XXS',
  'XS',
  'S',
  'M',
  'L',
  'XL',
  'XXL',
  '2XL',
  '3XL',
  '4XL',
  '5XL',
  'FREE SIZE',
  'FREESIZE',
  'FREE',
  'F',
  'ONE SIZE',
  'ONESIZE',
  'O',
];

/**
 * Formats variant size for customer-facing display.
 * Freesize variants (F, Free, Freesize, etc.) must be displayed as 'FREE SIZE'.
 */
export function formatSizeDisplay(size: string | null | undefined): string {
  if (!size) return '';
  const trimmed = size.trim();
  const upper = trimmed.toUpperCase();
  if (
    upper === 'F' ||
    upper === 'FREE' ||
    upper === 'FREESIZE' ||
    upper === 'FREE-SIZE' ||
    upper === 'FREE SIZE'
  ) {
    return 'FREE SIZE';
  }
  return trimmed;
}

/**
 * Sorts sizes in standard fashion progression from smallest to largest:
 * XXS -> XS -> S -> M -> L -> XL -> XXL -> FREE SIZE, or numeric progression (35 -> 42).
 */
export function sortSizes(sizes: string[]): string[] {
  return [...sizes].sort((a, b) => {
    const ua = a.trim().toUpperCase().replace(/[-\s]+/g, ' ');
    const ub = b.trim().toUpperCase().replace(/[-\s]+/g, ' ');

    const normA = (ua === 'F' || ua === 'FREE' || ua === 'FREESIZE' || ua === 'FREE SIZE') ? 'FREE SIZE' : ua;
    const normB = (ub === 'F' || ub === 'FREE' || ub === 'FREESIZE' || ub === 'FREE SIZE') ? 'FREE SIZE' : ub;

    const ia = SIZE_ORDER.indexOf(normA);
    const ib = SIZE_ORDER.indexOf(normB);

    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;

    const na = Number(ua);
    const nb = Number(ub);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      return na - nb;
    }

    return ua.localeCompare(ub);
  });
}
