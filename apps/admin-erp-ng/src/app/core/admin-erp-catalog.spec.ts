import {
  SKU_PATTERN,
  allowedStatusTransitions,
  buildVariantMatrix,
  duplicateSkus,
  guessColorHex,
  lowStockVariants,
  normalizeColorCode,
  parseListInput,
  productStatusLabel,
  productStatusTone,
  slugifyProductText,
  stockDelta,
  variantStockTotal,
} from './admin-erp-catalog';

describe('catalog rules mirrored from the API', () => {
  it('builds one matrix row per color and size with a unique SKU segment', () => {
    const matrix = buildVariantMatrix('vl-dam001', ['Đen', ' Đỏ Ruby '], ['s', 'M'], 12, 4);

    expect(matrix.length).toBe(4);
    expect(matrix[0]).toEqual({
      sku: 'VL-DAM001-DEN-S',
      color: 'Đen',
      colorHex: '#1A1A1A',
      size: 'S',
      stockQuantity: 12,
      lowStockThreshold: 4,
    });
    expect(matrix[2].sku).toBe('VL-DAM001-DORUBY-S');
    expect(matrix[3].sku).toBe('VL-DAM001-DORUBY-M');
    expect(matrix.every((row) => SKU_PATTERN.test(String(row.sku)))).toBe(true);
  });

  it('keeps the generated SKU inside the catalog pattern', () => {
    expect(SKU_PATTERN.test('VL-AO001')).toBe(true);
    expect(SKU_PATTERN.test('VL-AO001-DEN-M')).toBe(true);
    expect(SKU_PATTERN.test('vl-ao001')).toBe(false);
    expect(SKU_PATTERN.test('A-1')).toBe(false);
    expect(normalizeColorCode('Đỏ Ruby')).toBe('DORUBY');
    expect(guessColorHex('Xanh Lam')).toBe('#1E3A8A');
  });

  it('slugifies names the way the create endpoint expects', () => {
    expect(slugifyProductText('  Áo Khoác Lụa  ')).toBe('ao-khoac-lua');
    expect(slugifyProductText('Đầm Len Xám')).toBe('dam-len-xam');
    expect(slugifyProductText('!!!')).toBe('');
  });

  it('reports duplicated SKUs case- and space-insensitively', () => {
    expect(duplicateSkus(['VL-A001', ' vl-a001 ', 'VL-B002'])).toEqual(['VL-A001']);
    expect(duplicateSkus(['VL-A001', 'VL-B002'])).toEqual([]);
  });

  it('only offers legal transitions from the stored status', () => {
    expect(allowedStatusTransitions('on_sale')).toEqual(['hidden', 'out_of_stock', 'discontinued']);
    expect(allowedStatusTransitions('discontinued')).toEqual(['on_sale', 'hidden', 'out_of_stock']);
    expect(allowedStatusTransitions('unknown-state')).toEqual(['hidden']);
    expect(productStatusLabel('hidden')).toBe('Tạm ẩn');
    expect(productStatusLabel('unknown-state')).toBe('unknown-state');
    expect(productStatusTone('out_of_stock')).toBe('danger');
  });

  it('sums stock and finds variants at or below their own threshold', () => {
    const variants = [
      { variant_id: 'v1', stock_quantity: 2, low_stock_threshold: 5 },
      { variant_id: 'v2', stock_quantity: 9, low_stock_threshold: 5 },
      { variant_id: 'v3', stock_quantity: 5, low_stock_threshold: 5 },
    ];

    expect(variantStockTotal(variants)).toBe(16);
    expect(lowStockVariants(variants).map((row) => row.variant_id)).toEqual(['v1', 'v3']);
    expect(lowStockVariants(undefined)).toEqual([]);
  });

  it('turns an adjustment intent into the signed delta the API wants', () => {
    expect(stockDelta('in', 10, 5)).toBe(5);
    expect(stockDelta('out', 10, 12)).toBe(-12);
    expect(stockDelta('set', 10, 4)).toBe(-6);
    expect(stockDelta('set', 10, 10)).toBe(0);
  });

  it('splits comma, semicolon and newline separated lists', () => {
    expect(parseListInput('Đen, Đỏ Ruby;\nXanh Lam,,')).toEqual(['Đen', 'Đỏ Ruby', 'Xanh Lam']);
  });
});
