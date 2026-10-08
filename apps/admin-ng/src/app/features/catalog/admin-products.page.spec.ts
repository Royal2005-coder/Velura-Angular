import { createAdminPage } from '../../../testing/admin-testing';
import { AdminProductsPage } from './admin-products.page';
import { TestBed } from '@angular/core/testing';
import { AdminSessionService } from '../../core/admin-session.service';

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

  it('calculates live discount percentage and validates price correctly', async () => {
    const page = await createAdminPage(AdminProductsPage);
    page.editBasePrice.set(500_000);
    page.editSalePrice.set(400_000);
    expect(page.editDiscountPct()).toBe(20);
    expect(page.editPriceInvalid()).toBe(false);

    // Sale price higher than base price is invalid
    page.editSalePrice.set(600_000);
    expect(page.editPriceInvalid()).toBe(true);
    expect(page.editDiscountPct()).toBe(0);

    // No sale price: 0% discount, valid
    page.editSalePrice.set(null);
    expect(page.editDiscountPct()).toBe(0);
    expect(page.editPriceInvalid()).toBe(false);
  });

  it('manages combo composition and savings with default quantity 1', async () => {
    const page = await createAdminPage(AdminProductsPage);
    expect(page.addComboQuantity()).toBe(1);

    page.editBasePrice.set(500_000);
    page.editSalePrice.set(399_000);
    page.comboItems.set([
      {
        combo_item_id: 'ci_1',
        combo_product_id: 'combo_1',
        component_product_id: 'comp_1',
        quantity: 1,
        product: { product_id: 'comp_1', name: 'Áo Thun', sku: 'VL-AO001', base_price: 250_000, sale_price: 250_000 },
      },
      {
        combo_item_id: 'ci_2',
        combo_product_id: 'combo_1',
        component_product_id: 'comp_2',
        quantity: 1,
        product: { product_id: 'comp_2', name: 'Quần Short', sku: 'VL-QU001', base_price: 300_000, sale_price: 300_000 },
      },
    ]);

    // Total original: 250k + 300k = 550k
    expect(page.comboTotalOriginal()).toBe(550_000);
    // Combo sale price: 399k -> Savings: 550k - 399k = 151k
    expect(page.comboSavings()).toBe(151_000);
    expect(page.comboSavingsPct()).toBe(27);
  });

  it('replaces only the deliberately selected image with the approved URL without publishing', async () => {
    const page = await createAdminPage(AdminProductsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({
      user: { id: 'operator' }, role: 'admin_operator_sanpham', isAdmin: true, allowedModules: ['products'], allowedPages: ['products'],
    });
    page.selected.set({ product_id: 'p1', name: 'Áo', version: 3, images: ['old-a', 'old-b'] });
    page.sourceFile.set(new File(['source'], 'source.png', { type: 'image/png' }));
    page.imageIndex.set(1);
    const images = document.createElement('textarea');
    images.value = 'old-a\nold-b';
    const approval = { approvalId: 'review', url: 'https://storage/ai-reviewed/review.png',
      sourceRevision: 'hash', processingVersion: 'quality-v1', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    page.acceptAiImage(approval, images);
    expect(images.value).toBe(`old-a\n${approval.url}`);
    expect(page.selected()?.images).toEqual(['old-a', 'old-b']);
    expect(page.imageApprovals()).toEqual([approval]);
    expect(page.sourceApproved()).toBe(true);
  });

  it('ignores expired approval and keeps the previous published content', async () => {
    const page = await createAdminPage(AdminProductsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({
      user: { id: 'operator' }, role: 'admin_operator_sanpham', isAdmin: true, allowedModules: ['products'], allowedPages: ['products'],
    });
    page.selected.set({ product_id: 'p1', name: 'Published title', description: 'Published description',
      seo_title: 'Published SEO', seo_description: 'Published meta', slug: 'published', version: 3, images: ['old'] });
    page.sourceFile.set(new File(['source'], 'source.png', { type: 'image/png' }));
    const images = document.createElement('textarea');
    images.value = 'old';
    page.acceptAiImage({ approvalId: 'expired', url: 'new', sourceRevision: 'hash', processingVersion: 'v1', expiresAt: '2000-01-01' }, images);
    expect(images.value).toBe('old');
    expect(page.imageApprovals()).toEqual([]);
    expect(page.liveContent()).toEqual({ title: 'Published title', description: 'Published description',
      seoTitle: 'Published SEO', metaDescription: 'Published meta', slug: 'published' });
  });

  it('keeps bulk content selection version-bound and removes unchecked rows', async () => {
    const page = await createAdminPage(AdminProductsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({
      user: { id: 'operator' }, role: 'admin_operator_sanpham', isAdmin: true, allowedModules: ['products'], allowedPages: ['products'],
    });
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = true;
    const product = { product_id: 'p1', name: 'Áo', version: 3 };
    page.toggleContentProduct(product, { target: checkbox } as unknown as Event);
    expect(page.bulkSelection()).toEqual([{ productId: 'p1', expectedVersion: 3 }]);
    checkbox.checked = false;
    page.toggleContentProduct(product, { target: checkbox } as unknown as Event);
    expect(page.bulkSelection()).toEqual([]);
  });
});
