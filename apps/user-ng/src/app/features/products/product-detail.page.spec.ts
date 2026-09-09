import { createStorefrontPage } from '../../../testing/storefront-testing';
import { ProductDetailPage } from './product-detail.page';

describe('ProductDetailPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    expect(page).toBeTruthy();
  });

  it('hydrates the product signal from CatalogService.getProduct', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    expect(page.loading()).toBe(false);
    expect(page.product()?.product_id).toBe('p1');
    expect(page.quantity()).toBe(1);
  });
});
