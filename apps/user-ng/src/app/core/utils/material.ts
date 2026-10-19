import { ProductSummary } from '../models/product.interface';

/** Matches the `Chất liệu: Cotton` line the admin product form appends to a description. */
const MATERIAL_LINE = /^\s*(?:chất liệu|material)\s*[:：]\s*(.+?)\s*$/im;

/**
 * Reads the fabric the admin entered for a product, or `null` when the description has no
 * `Chất liệu:` line. The storefront never invents a material.
 */
export function productMaterial(product: Pick<ProductSummary, 'description'>): string | null {
  const match = MATERIAL_LINE.exec(product.description || '');
  return match ? match[1] : null;
}

/**
 * Text a material filter is compared with: the declared fabric when present, otherwise the
 * name and description, so `Cotton` still finds a product whose name or story mentions it.
 */
export function productMaterialText(product: Pick<ProductSummary, 'name' | 'description'>): string {
  return productMaterial(product) ?? `${product.name || ''} ${product.description || ''}`;
}
