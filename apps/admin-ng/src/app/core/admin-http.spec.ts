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

  it('shows the Vietnamese API message for a raw database error envelope (status transition, duplicate SKU)', () => {
    const transition = new HttpErrorResponse({
      status: 422,
      error: {
        error: {
          code: 'INVALID_STATUS_TRANSITION',
          message: 'Không thể chuyển sang trạng thái này từ trạng thái hiện tại',
          details: { code: 'PT422', message: 'INVALID_STATUS_TRANSITION', details: null, hint: null },
        },
      },
    });
    expect(adminErrorMessage(transition)).toBe('Không thể chuyển sang trạng thái này từ trạng thái hiện tại');
    const duplicate = new HttpErrorResponse({
      status: 409,
      error: { error: { code: 'SKU_DUPLICATE', message: 'Mã SKU đã tồn tại, SKU phải là duy nhất trên toàn hệ thống' } },
    });
    expect(adminErrorMessage(duplicate)).toBe('Mã SKU đã tồn tại, SKU phải là duy nhất trên toàn hệ thống');
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
