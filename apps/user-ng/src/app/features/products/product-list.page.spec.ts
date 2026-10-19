import { createStorefrontPage } from '../../../testing/storefront-testing';
import { ProductListPage } from './product-list.page';

describe('ProductListPage', () => {
  it('keeps visual candidates based on catalog filters independently of previous image matches', async () => {
    const page = await createStorefrontPage(ProductListPage);
    const originalIds = page.imageSearchCandidates();
    expect(originalIds.length).toBe(1);
    page.applyImageMatches([]);
    expect(page.productCount()).toBe(0);
    expect(page.imageSearchCandidates()).toEqual(originalIds);
    page.searchQuery.set('không-tồn-tại-xyz');
    expect(page.imageSearchCandidates()).toEqual([]);
  });
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(ProductListPage);
    expect(page).toBeTruthy();
  });

  it('keeps filter state on signals — template must not call .filter()', async () => {
    const page = await createStorefrontPage(ProductListPage);
    expect(page.loading()).toBe(false);
    expect(page.productCount()).toBe(1);
    page.searchQuery.set('không-tồn-tại-xyz');
    expect(page.productCount()).toBe(0);
    page.searchQuery.set('linen');
    expect(page.productCount()).toBe(1);
    expect(page.activeCategoryLabel()).toContain('linen');
  });

  it('displays and clears active promotional voucher code', async () => {
    const page = await createStorefrontPage(ProductListPage);
    expect(page.activeVoucherCode()).toBeNull();

    page.activeVoucherCode.set('FALL10');
    expect(page.activeVoucherCode()).toBe('FALL10');

    page.clearActiveVoucher();
    expect(page.activeVoucherCode()).toBeNull();
    expect(localStorage.getItem('checkout_voucher_code')).toBeNull();
  });

  it('finds a renamed product by its new name and no longer by the old name (UAT 3.1.10-25)', async () => {
    const page = await createStorefrontPage(ProductListPage);
    page.allProducts.set([
      { product_id: 'p1', name: 'Premium Cotton 100%', category_slug: 'ao', category_name: 'Áo', description: 'Mềm mại\nChất liệu: Cotton', base_price: 400000 },
      { product_id: 'p2', name: 'Quần lanh', category_slug: 'quan', category_name: 'Quần', description: 'Chất liệu: Lanh', base_price: 400000 },
    ]);

    page.searchQuery.set('Premium Cotton 100%');
    expect(page.filteredProducts().map((item) => item.product_id)).toEqual(['p1']);
    // "Áo" is the category word the old name shared: the other words must match too.
    page.searchQuery.set('Áo thun basic');
    expect(page.productCount()).toBe(0);
    page.searchQuery.set('*');
    expect(page.productCount()).toBe(0);
  });

  it('filters by material and category and lists only materials admins declared', async () => {
    const page = await createStorefrontPage(ProductListPage);
    page.allProducts.set([
      { product_id: 'p1', name: 'Premium Cotton 100%', category_slug: 'ao', description: 'Chất liệu: Cotton', base_price: 400000 },
      { product_id: 'p2', name: 'Quần lanh', category_slug: 'quan', description: 'Chất liệu: Lanh', base_price: 400000 },
      { product_id: 'p3', name: 'Váy', category_slug: 'dam-vay', description: 'Không nêu chất liệu', base_price: 400000 },
    ]);

    expect(page.materialOptions()).toEqual(['Cotton', 'Lanh']);
    page.selectMaterial('cotton');
    expect(page.filteredProducts().map((item) => item.product_id)).toEqual(['p1']);
    page.selectedSlugs.set(['quan']);
    expect(page.productCount()).toBe(0);
    page.selectedSlugs.set(['ao']);
    expect(page.filteredProducts().map((item) => item.product_id)).toEqual(['p1']);
    page.selectMaterial('Lanh');
    expect(page.productCount()).toBe(0);
  });
});
