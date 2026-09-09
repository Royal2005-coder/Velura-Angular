import { createAdminPage } from '../../../testing/admin-testing';
import { AdminProductsPage } from './admin-products.page';

describe('AdminProductsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminProductsPage);
    expect(page).toBeTruthy();
  });

  it('filters the catalog on signals, not in the template', async () => {
    const page = await createAdminPage(AdminProductsPage);
    page.products.set([
      { product_id: '1', name: 'Áo linen', sku: 'AO-1', status: 'on_sale', category_name: 'Áo' },
      { product_id: '2', name: 'Quần kaki', sku: 'QU-1', status: 'hidden', category_name: 'Quần' },
    ]);
    expect(page.onSale()).toBe(1);
    expect(page.hidden()).toBe(1);
    page.query.set('linen');
    expect(page.filtered().map((row) => row.sku)).toEqual(['AO-1']);
  });
});
