import { ProductSummary } from '../../core/models/product.interface';
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

  it('manages combo set quantity stepper and scales line items and summary accordingly', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    const comboProduct = {
      product_id: 'combo-1',
      name: 'Set Áo Linen và Quần Tây',
      slug: 'set-ao-quan',
      base_price: 900000,
      sale_price: 750000,
      is_combo: true,
      combo_components: [
        {
          product_id: 'comp-1',
          name: 'Áo Linen',
          slug: 'ao-linen',
          base_price: 500000,
          quantity: 1,
          variants: [{ variant_id: 'cv1', color: 'Trắng', size: 'M', stock_quantity: 20 }],
        },
        {
          product_id: 'comp-2',
          name: 'Quần Tây',
          slug: 'quan-tay',
          base_price: 400000,
          quantity: 1,
          variants: [{ variant_id: 'cv2', color: 'Đen', size: 'L', stock_quantity: 15 }],
        },
      ],
    };
    page.product.set(comboProduct as unknown as ProductSummary);
    page.comboPicks.set([
      { productId: 'comp-1', color: 'Trắng', size: 'M' },
      { productId: 'comp-2', color: 'Đen', size: 'L' },
    ]);

    expect(page.isCombo()).toBe(true);
    expect(page.quantity()).toBe(1);

    // Summary for quantity 1
    const summary1 = page.comboSummary();
    expect(summary1.setPriceLabel).toContain('750.000');
    expect(summary1.retailLabel).toContain('900.000');

    // Increment combo quantity to 2
    page.increment();
    expect(page.quantity()).toBe(2);

    // Summary for quantity 2
    const summary2 = page.comboSummary();
    expect(summary2.setPriceLabel).toContain('1.500.000');
    expect(summary2.retailLabel).toContain('1.800.000');

    // Decrement combo quantity back to 1
    page.decrement();
    expect(page.quantity()).toBe(1);
  });
});
