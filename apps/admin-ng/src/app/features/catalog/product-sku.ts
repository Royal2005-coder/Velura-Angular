/** Shown inline and on submit whenever a product or variant SKU already exists; mirrors the API `SKU_DUPLICATE` message. */
export const SKU_DUPLICATE_MESSAGE = 'Mã SKU đã tồn tại, SKU phải là duy nhất trên toàn hệ thống';

/** Shown when the typed SKU does not match the catalog format (e.g. VL-AO001). */
export const SKU_FORMAT_MESSAGE = 'SKU phải dạng VL-AO001 hoặc VLR-DV006 (chữ in hoa, có gạch ngang)';

/** Catalog SKU pattern, identical to the API `SKU_PATTERN`. */
export const SKU_PATTERN = /^[A-Z]{2,6}-[A-Z0-9]{2,20}(-[A-Z0-9]{1,10})*$/;

/**
 * Returns the normalized SKUs used more than once in one form (trimmed, case-insensitive).
 * Used to flag duplicate variant SKUs before any request reaches the server.
 */
export function duplicateSkus(skus: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const raw of skus) {
    const sku = raw.trim().toUpperCase();
    if (!sku) continue;
    if (seen.has(sku)) duplicates.add(sku);
    seen.add(sku);
  }
  return [...duplicates];
}
