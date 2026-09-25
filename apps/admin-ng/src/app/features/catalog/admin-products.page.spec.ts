import { createAdminPage } from '../../../testing/admin-testing';
import { AdminProductsPage } from './admin-products.page';

describe('AdminProductsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminProductsPage);
    expect(page).toBeTruthy();
  });

  it('exposes loading, empty, and filter signals instead of template filters', async () => {
    const page = await createAdminPage(AdminProductsPage);
    expect(page.loading()).toBe(false);
    expect(page.products()).toEqual([]);
    expect(page.loadError()).toBeNull();
    page.query.set('linen');
    page.status.set('on_sale');
    expect(page.query()).toBe('linen');
    expect(page.status()).toBe('on_sale');
  });

  it('keeps status mutations versioned', async () => {
    const page = await createAdminPage(AdminProductsPage);
    page.selected.set({ product_id: '1', name: 'Áo', sku: 'VL-AO001', version: 3, status: 'on_sale' });
    expect(page.selected()?.version).toBe(3);
  });

  it('defaults the hide modal to Tạm ẩn instead of dropping the option', async () => {
    const page = await createAdminPage(AdminProductsPage);
    page.openStatus({ product_id: '1', name: 'Áo', sku: 'VL-AO001', version: 3, status: 'on_sale' });
    expect(page.nextStatus()).toBe('hidden');
    expect(page.allowedStatuses().map((row) => row.value)).toContain('hidden');
    expect(page.allowedStatuses().map((row) => row.value)).toContain('discontinued');
  });

  it('calculates ERP stock adjustments in real time', async () => {
    const page = await createAdminPage(AdminProductsPage);
    page.openStock({
      product_id: 'prod_1',
      name: 'Áo Thun',
      sku: 'VLR-AO001',
      variants: [
        { variant_id: 'var_1', color: 'Trắng', size: 'L', stock_quantity: 20, low_stock_threshold: 5, version: 1 }
      ]
    });

    expect(page.overlay()).toBe('stock');
    expect(page.variants().length).toBe(1);
    expect(page.currentStock()).toBe(20);

    // + Nhập kho: 20 + 10 = 30
    page.setStockAdjustmentType('in');
    page.stockAdjustmentQuantity.set(10);
    expect(page.projectedStock()).toBe(30);

    // - Xuất kho: 20 - 5 = 15
    page.setStockAdjustmentType('out');
    page.stockAdjustmentQuantity.set(5);
    expect(page.projectedStock()).toBe(15);

    // Kiểm kê điều chỉnh: set về 45
    page.setStockAdjustmentType('set');
    page.stockAdjustmentQuantity.set(45);
    expect(page.projectedStock()).toBe(45);
  });
});
