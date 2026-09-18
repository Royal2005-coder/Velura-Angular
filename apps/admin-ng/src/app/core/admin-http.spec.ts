import { HttpErrorResponse } from '@angular/common/http';
import { adminErrorMessage, formatErrorDetails } from './admin-http';

describe('adminErrorMessage', () => {
  it('flattens field validation details instead of Request validation failed', () => {
    const error = new HttpErrorResponse({
      status: 422,
      error: {
        error: {
          message: 'Request validation failed',
          details: { sku: ['SKU phải dạng VL-AO001 hoặc VLR-DV006 (chữ in hoa, có gạch ngang)'] },
        },
      },
    });
    expect(adminErrorMessage(error)).toContain('sku:');
    expect(adminErrorMessage(error)).toContain('VL-AO001');
  });

  it('formats CSV row errors for the preview table', () => {
    expect(
      formatErrorDetails([{ row: 3, field: 'sku', message: 'SKU không đúng dạng VL-AO001' }]),
    ).toContain('Dòng 3');
  });
});

describe('adminListRows', () => {
  it('unwraps nested { data: { rows } } category payloads', async () => {
    const { adminListRows } = await import('./admin-http');
    expect(
      adminListRows({ data: { rows: [{ category_id: 'c1', name: 'Áo' }], count: 1 } } as never),
    ).toEqual([{ category_id: 'c1', name: 'Áo' }]);
  });
});
