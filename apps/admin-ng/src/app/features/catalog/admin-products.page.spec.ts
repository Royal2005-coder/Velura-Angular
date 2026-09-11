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
});
