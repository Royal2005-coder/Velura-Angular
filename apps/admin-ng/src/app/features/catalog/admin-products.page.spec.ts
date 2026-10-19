import { of, Subject } from 'rxjs';
import { vi } from 'vitest';
import { createAdminPage } from '../../../testing/admin-testing';
import { AdminProductsPage } from './admin-products.page';
import { TestBed } from '@angular/core/testing';
import { AdminSessionService } from '../../core/admin-session.service';
import type { AdminProductRow, AdminProductVariant } from '../../core/admin-api.service';
import { HttpErrorResponse } from '@angular/common/http';
import type { ProductImageApproval } from '../../core/product-image-approval.service';


async function chooseCsv(page: AdminProductsPage, content: string): Promise<void> {
  const input = document.createElement('input');
  input.type = 'file';
  Object.defineProperty(input, 'files', { value: [new File([content], 'products.csv', { type: 'text/csv' })] });
  page.onCsvFile({ target: input } as unknown as Event);
  await vi.waitFor(() => expect(page.csvPreview()).toBe(content));
}

function grantProductAccess(): void {
  TestBed.inject(AdminSessionService).applyAuthContext({
    user: { id: 'operator' }, role: 'admin_operator_sanpham', isAdmin: true,
    allowedModules: ['products'], allowedPages: ['products'],
  });
}
describe('AdminProductsPage', () => {
  it('retains authoritative variants when detail arrives after the variant list', async () => {
    const detail = new Subject<AdminProductRow>();
    const variants = new Subject<{ rows: AdminProductVariant[] }>();
    const page = await createAdminPage(AdminProductsPage, {
      getProduct: () => detail, listVariants: () => variants,
    });
    const rows = [
      { variant_id: 'black', color: 'Đen', size: 'S', stock_quantity: 50 },
      { variant_id: 'white', color: 'Trắng', size: 'S', stock_quantity: 30 },
    ];
    page.openEdit({ product_id: 'p', name: 'Áo', status: 'hidden' });
    variants.next({ rows }); variants.complete();
    detail.next({ product_id: 'p', name: 'Áo', status: 'hidden' }); detail.complete();
    expect(page.variants()).toEqual(rows);
  });

  it('blocks import while preview is pending, failed, or contains duplicate SKU errors', async () => {
    const previews = [new Subject<unknown>(), new Subject<unknown>()];
    const commitCsv = vi.fn(() => of({ failed: 0 }));
    const page = await createAdminPage(AdminProductsPage, { previewCsv: vi.fn()
      .mockReturnValueOnce(previews[0]).mockReturnValueOnce(previews[1]), commitCsv });
    grantProductAccess();
    await chooseCsv(page, 'sku,name\nVL-AO001,Áo');
    page.commitCsv();
    expect(commitCsv).not.toHaveBeenCalled();
    previews[0].error(new Error('Preview unavailable'));
    page.commitCsv();
    expect(commitCsv).not.toHaveBeenCalled();
    await chooseCsv(page, 'sku,name\nVL-AO001,Áo\nVL-AO001,Áo khác');
    previews[1].next({ rows: [], errors: [{ row: 3, field: 'sku', message: 'SKU trùng dòng 2' }], validRows: 0, totalRows: 2 });
    page.commitCsv();
    expect(commitCsv).not.toHaveBeenCalled();
    expect(page.csvErrors()[0].field).toBe('sku');
  });

  it('consumes preview approval and prevents double submission', async () => {
    const preview = new Subject<unknown>(), committed = new Subject<unknown>();
    const commitCsv = vi.fn(() => committed);
    const page = await createAdminPage(AdminProductsPage, { previewCsv: () => preview, commitCsv });
    grantProductAccess();
    await chooseCsv(page, 'sku,name\nVL-AO001,Áo');
    preview.next({ rows: [{ sku: 'VL-AO001' }], errors: [], validRows: 1, totalRows: 1 });
    expect(page.canCommitCsv()).toBe(true);
    page.commitCsv(); page.commitCsv();
    expect(commitCsv).toHaveBeenCalledTimes(1);
    committed.next({ failed: 0 }); committed.complete();
    expect(page.canCommitCsv()).toBe(false);
  });

  it('does not apply an old file preview to a replacement file', async () => {
    const first = new Subject<unknown>(), second = new Subject<unknown>();
    const page = await createAdminPage(AdminProductsPage, { previewCsv: vi.fn()
      .mockReturnValueOnce(first).mockReturnValueOnce(second) });
    grantProductAccess();
    await chooseCsv(page, 'sku,name\nVL-AO001,Áo');
    await chooseCsv(page, 'sku,name\nVL-AO002,Áo khác');
    first.next({ rows: [{ sku: 'VL-AO001' }], errors: [], validRows: 1, totalRows: 1 });
    expect(page.canCommitCsv()).toBe(false);
    second.next({ rows: [], errors: [{ row: 2, field: 'sale_price', message: 'Dùng Điều chỉnh giá' }], validRows: 0, totalRows: 1 });
    expect(page.csvErrors()[0].field).toBe('sale_price');
    expect(page.csvRows()).toEqual([]);
    expect(page.canCommitCsv()).toBe(false);
  });

  it('shows commit-time row errors and requires a new preview', async () => {
    const committed = new Subject<unknown>();
    const page = await createAdminPage(AdminProductsPage, {
      previewCsv: () => of({ rows: [{ sku: 'VL-AO001' }], errors: [], validRows: 1, totalRows: 1 }),
      commitCsv: () => committed,
    });
    grantProductAccess();
    await chooseCsv(page, 'sku,name\nVL-AO001,Áo');
    page.commitCsv();
    committed.error(new HttpErrorResponse({ status: 422, error: { error: { details: {
      errors: [{ row: 2, field: 'sale_price', message: 'Giá đã đổi, dùng Điều chỉnh giá' }],
    } } } }));
    expect(page.csvErrors()).toEqual([{ row: 2, field: 'sale_price', message: 'Giá đã đổi, dùng Điều chỉnh giá' }]);
    expect(page.canCommitCsv()).toBe(false);
  });
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

  it('allows discontinued products to transition back to on_sale and hidden', async () => {
    const page = await createAdminPage(AdminProductsPage);
    page.openStatus({ product_id: '1', name: 'Áo', sku: 'VL-AO001', version: 3, status: 'discontinued' });
    expect(page.nextStatus()).toBe('on_sale');
    expect(page.allowedStatuses().map((row) => row.value)).toContain('on_sale');
    expect(page.allowedStatuses().map((row) => row.value)).toContain('hidden');
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
  it('keeps explicit colors when promoting and replacing a primary image', async () => {
    const page = await createAdminPage(AdminProductsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({
      user: { id: 'operator' }, role: 'admin_operator_sanpham', isAdmin: true,
      allowedModules: ['products'], allowedPages: ['products'],
    });
    page.editorImages.set(['/a.jpg', '/b.jpg', '/c.jpg']);
    page.editorImageColors.set({ '/a.jpg': 'Đen', '/b.jpg': 'Trắng' });
    page.setPrimaryImage(1);
    expect(page.editorImages()).toEqual(['/b.jpg', '/a.jpg', '/c.jpg']);
    expect(page.imageIndex()).toBe(0);
    expect(page.editorImageColors()['/b.jpg']).toBe('Trắng');
    page.sourceFile.set(new File(['source'], 'source.png', { type: 'image/png' }));
    const box = document.createElement('textarea');
    box.value = page.editorImages().join('\n');
    page.acceptAiImage({ approvalId: 'review', url: '/replacement.jpg', sourceRevision: 'hash',
      processingVersion: 'quality-v1', expiresAt: new Date(Date.now() + 60_000).toISOString() }, box);
    expect(page.editorImages()[0]).toBe('/replacement.jpg');
    expect(page.editorImageColors()).toEqual({ '/a.jpg': 'Đen', '/replacement.jpg': 'Trắng' });
  });

  it('rejects a twenty-first image and protects the last primary image', async () => {
    const page = await createAdminPage(AdminProductsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({
      user: { id: 'operator' }, role: 'admin_operator_sanpham', isAdmin: true,
      allowedModules: ['products'], allowedPages: ['products'],
    });
    const images = Array.from({ length: 20 }, (_, index) => `/image-${index}.jpg`);
    page.editorImages.set(images);
    page.imageIndex.set(20);
    page.sourceFile.set(new File(['source'], 'source.png', { type: 'image/png' }));
    const box = document.createElement('textarea');
    box.value = images.join('\n');
    page.acceptAiImage({ approvalId: 'review', url: '/extra.jpg', sourceRevision: 'hash',
      processingVersion: 'quality-v1', expiresAt: new Date(Date.now() + 60_000).toISOString() }, box);
    expect(page.editorImages()).toEqual(images);
    expect(page.aiImageError()).toContain('20');
    page.editorImages.set(['/primary.jpg']);
    page.removeGalleryImageSlot(0);
    expect(page.editorImages()).toEqual(['/primary.jpg']);
  });

  it('assigns only actual variant colors and removes deleted image associations', async () => {
    const page = await createAdminPage(AdminProductsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({
      user: { id: 'operator' }, role: 'admin_operator_sanpham', isAdmin: true,
      allowedModules: ['products'], allowedPages: ['products'],
    });
    page.editorImages.set(['/a.jpg', '/b.jpg']);
    page.variants.set([{ variant_id: 'black', color: 'Đen' }]);
    const select = document.createElement('select');
    select.add(new Option('Đen', 'Đen'));
    page.setImageColor('/b.jpg', { target: select } as unknown as Event);
    expect(page.editorImageColors()).toEqual({ '/b.jpg': 'Đen' });
    page.removeGalleryImageSlot(1);
    expect(page.editorImageColors()).toEqual({});
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

  it('optimizes description, SEO fields, and User PDP attributes via Gemini Fashion SEO', async () => {
    const page = await createAdminPage(AdminProductsPage, {
      optimizeProductSeo: () =>
        of({
          description: 'Áo sơ mi lụa cao cấp thuộc BST Timeless Silk, chất liệu mềm mịn thoáng mát.',
          seoTitle: 'Áo Sơ Mi Lụa Tay Dài Ivory - Timeless Silk | Velura',
          seoDescription: 'Khám phá Áo Sơ Mi Lụa Tay Dài Ivory cao cấp tại Velura Atelier.',
          slug: 'ao-so-mi-lua-tay-dai-ivory',
          brand: 'Velura',
          collection: 'Timeless Silk',
          material: 'Lụa Tơ Tằm Thượng Hạng',
          colorTone: 'Warm',
          styleTags: ['Elegant', 'Smart Casual', 'ao so mi lua'],
          occasions: ['Office', 'Party'],
          suitableBodyShapes: ['Hourglass', 'Rectangle'],
          highlights: ['Chất liệu lụa mềm mịn', 'Phom dáng thanh lịch'],
          careInstructions: ['Giặt tay nhẹ nhàng', 'Ủi hơi nước nhiệt độ thấp'],
          seoKeywords: ['ao so mi lua', 'so mi velura'],
          seoScore: 96,
          modelUsed: 'gemini-3.5-flash-lite',
        }),
    });
    TestBed.inject(AdminSessionService).applyAuthContext({
      user: { id: 'operator' },
      role: 'admin_operator_sanpham',
      isAdmin: true,
      allowedModules: ['products'],
      allowedPages: ['products'],
    });
    page.selected.set({ product_id: 'p1', name: 'Áo Sơ Mi Lụa Tay Dài Ivory', sku: 'VLR-AO-002', version: 2 });
    page.optimizeSeoWithAi();
    expect(page.editorSeoTitle()).toBe('Áo Sơ Mi Lụa Tay Dài Ivory - Timeless Silk | Velura');
    expect(page.editorCollection()).toBe('Timeless Silk');
    expect(page.editorColorTone()).toBe('Warm');
    expect(page.editorOccasions()).toEqual(['Office', 'Party']);
    expect(page.editorBodyShapes()).toEqual(['Hourglass', 'Rectangle']);
    expect(page.aiSeoResult()?.seoScore).toBe(96);
  });

  it('enhances product image via AI Studio and applies approved URL into gallery', async () => {
    const page = await createAdminPage(AdminProductsPage, {
      approveStudioImage: () => of({ approvalId: 'persisted', url: 'https://storage/product-images/ai-reviewed/persisted.png',
        sourceRevision: 'hash', processingVersion: 'studio-measured-v1', expiresAt: new Date(Date.now() + 60000).toISOString() }),
      enhanceProductImage: () =>
        of({
          enhancedUrl: 'https://storage/product-images/ai-studio/enhanced-1.png',
          previewDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
          modelUsed: 'k3s-u2net-apache2 + velura-studio-v2',
          improvements: ['Tách nền AI U2Net & chuẩn hóa nền Trắng Studio (#FFFFFF)'],
          beforeAnalysis: {
            overallScore: 68,
            passed: false,
            needsEnhancement: true,
            grade: 'C',
            statusLabel: 'Cần cải thiện',
            summary: 'Ảnh hơi tối',
            metrics: { width: 800, height: 800, brightness: 95, contrast: 30, sharpnessScore: 70, backgroundScore: 60 },
            criteria: [],
            recommendations: [],
          },
          afterAnalysis: {
            overallScore: 95,
            passed: true,
            needsEnhancement: false,
            grade: 'A',
            statusLabel: 'Đạt chuẩn Studio',
            summary: 'Ảnh đạt chuẩn',
            metrics: { width: 1080, height: 1080, brightness: 165, contrast: 48, sharpnessScore: 92, backgroundScore: 96 },
            criteria: [],
            recommendations: [],
          },
        }),
    });
    TestBed.inject(AdminSessionService).applyAuthContext({
      user: { id: 'operator' },
      role: 'admin_operator_sanpham',
      isAdmin: true,
      allowedModules: ['products'],
      allowedPages: ['products'],
    });
    page.editorImages.set(['/assets/images/old.jpg']);
    page.imageIndex.set(0);
    page.generateAiEnhancedImage();
    expect(page.aiEnhanceResult()?.enhancedUrl).toBe('https://storage/product-images/ai-studio/enhanced-1.png');
    expect(page.aiImageAnalysis()?.overallScore).toBe(95);

    const box = document.createElement('textarea');
    box.value = '/assets/images/old.jpg';
    page.applyAiEnhancedImage(box);
    expect(page.editorImages()[0]).toBe('https://storage/product-images/ai-reviewed/persisted.png');
    expect(box.value).toBe('https://storage/product-images/ai-reviewed/persisted.png');
    expect(page.sourceApproved()).toBe(true);
    expect(page.imageApprovals().length).toBe(1);
  });

  it('keeps the gallery unchanged and blocks saving until Studio approval is persisted', async () => {
    const pending = new Subject<ProductImageApproval>();
    const page = await createAdminPage(AdminProductsPage, { approveStudioImage: () => pending });
    TestBed.inject(AdminSessionService).applyAuthContext({ user: { id: 'operator' }, role: 'admin_operator_sanpham',
      isAdmin: true, allowedModules: ['products'], allowedPages: ['products'] });
    page.editorImages.set(['published.png']);
    page.uploadedOriginalUrl.set('https://storage/uploads/original.png');
    page.applyOriginalUploadedImage();
    expect(page.aiImageBusy()).toBe(true);
    expect(page.editorImages()).toEqual(['published.png']);
    page.submitEditor(new Event('submit'));
    expect(page.actionError()).toContain('chờ hoàn tất xử lý');
    pending.error(new Error('Approval database unavailable'));
    expect(page.editorImages()).toEqual(['published.png']);
    expect(page.sourceApproved()).toBe(false);
    expect(page.aiImageBusy()).toBe(false);
  });

  it('applies and resets audit log filters with date, query, and action', async () => {
    let requestedParams: Record<string, string> | undefined;
    const page = await createAdminPage(AdminProductsPage, {
      listProductAuditLogs: (params: Record<string, string>) => {
        requestedParams = params;
        return of({ rows: [], count: 0 });
      },
    });

    page.logsQuery.set('UAT-Khai');
    page.logsDate.set('2026-10-18');
    page.logsAction.set('update_stock');
    page.applyLogsFilters();

    expect(requestedParams).toEqual({
      limit: '10',
      offset: '0',
      q: 'UAT-Khai',
      date: '2026-10-18',
      action: 'update_stock',
    });

    page.resetLogsFilters();
    expect(page.logsQuery()).toBe('');
    expect(page.logsDate()).toBe('');
    expect(page.logsAction()).toBe('');
  });

  it('opens and closes log detail modal and extracts reason correctly', async () => {
    const page = await createAdminPage(AdminProductsPage);
    const mockLog = {
      audit_id: 'log-1',
      action: 'update_stock',
      timestamp: '2026-10-18T10:00:00Z',
      new_value: { reason: 'Nhập hàng đợt 2 từ kho' },
      old_value: {},
    };

    page.openLogDetail(mockLog);
    expect(page.selectedLog()).toEqual(mockLog);
    expect(page.logReason(mockLog)).toBe('Nhập hàng đợt 2 từ kho');

    page.closeLogDetail();
    expect(page.selectedLog()).toBeNull();
  });
});
