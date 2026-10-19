import { of, Subject, throwError } from 'rxjs';
import { vi } from 'vitest';
import { createAdminPage, lastAdminFixture } from '../../../testing/admin-testing';
import { AdminProductsPage } from './admin-products.page';
import { TestBed } from '@angular/core/testing';
import { AdminSessionService } from '../../core/admin-session.service';
import type { AdminImageEnhanceResult, AdminImageQualityAnalysis, AdminProductRow, AdminProductVariant } from '../../core/admin-api.service';
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

  describe('AI image score and save guard', () => {
    const approveAs = (score: number) => (input: { imageUrl: string }) => of({ approvalId: 'persisted', url: input.imageUrl, sourceRevision: 'hash', processingVersion: 'studio-measured-v1', qualityScore: score, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const enhancedUrl = 'https://storage/product-images/ai-studio/improved.png';
    const analysis = (overallScore: number): AdminImageQualityAnalysis => ({
      overallScore, passed: overallScore >= 78, needsEnhancement: overallScore < 78, grade: overallScore >= 88 ? 'A' : 'C',
      statusLabel: 'Điểm đo', summary: 'Tóm tắt',
      metrics: { width: 1080, height: 1080, brightness: 140, contrast: 40, sharpnessScore: 80, backgroundScore: 80 },
      criteria: [], recommendations: [],
    });
    const enhanceResult = (): AdminImageEnhanceResult => ({
      enhancedUrl, previewDataUrl: '', modelUsed: 'velura-studio-v2', improvements: [],
      beforeAnalysis: analysis(73), afterAnalysis: analysis(91),
    });

    it('keeps the improved score 91 on the applied image instead of the original 73', async () => {
      const analyzeProductImage = vi.fn(() => of(analysis(73)));
      const page = await createAdminPage(AdminProductsPage, { approveStudioImage: approveAs(91), enhanceProductImage: () => of(enhanceResult()), analyzeProductImage });
      grantProductAccess();
      page.editorImages.set(['/old.jpg']);
      page.imageIndex.set(0);
      page.generateAiEnhancedImage();
      expect(page.aiImageAnalysis()?.overallScore).toBe(91);

      const box = document.createElement('textarea');
      box.value = '/old.jpg';
      page.applyAiEnhancedImage(box);
      expect(page.editorImages()).toEqual([enhancedUrl]);
      expect(page.aiImageAnalysis()?.overallScore).toBe(91);
      expect(page.imageScores()[enhancedUrl]?.overallScore).toBe(91);
      expect(page.imageScores()['/old.jpg']).toBeUndefined();
      expect(page.imageApprovals()[0].qualityScore).toBe(91);

      // Reselecting the applied slot must show the applied score, not re-measure it as the original.
      page.selectGalleryImageSlot(0);
      expect(analyzeProductImage).not.toHaveBeenCalled();
      expect(page.aiImageAnalysis()?.overallScore).toBe(91);
    });

    it('ignores a slow analysis of the original that finishes after the improved image was applied', async () => {
      const slow = new Subject<AdminImageQualityAnalysis>();
      const page = await createAdminPage(AdminProductsPage, { approveStudioImage: approveAs(91), enhanceProductImage: () => of(enhanceResult()), analyzeProductImage: () => slow });
      grantProductAccess();
      page.editorImages.set(['/old.jpg']);
      page.analyzeActiveImage();
      page.generateAiEnhancedImage();
      page.applyAiEnhancedImage(document.createElement('textarea'));
      slow.next(analysis(73)); slow.complete();
      expect(page.aiImageAnalysis()?.overallScore).toBe(91);
      expect(page.aiImageBusy()).toBe(false);
    });

    it('disables save with the exact Vietnamese message while any image step is processing and re-enables after', async () => {
      const pending = new Subject<AdminImageEnhanceResult>();
      const page = await createAdminPage(AdminProductsPage, { enhanceProductImage: () => pending });
      grantProductAccess();
      page.editorImages.set(['/old.jpg']);
      page.overlay.set('create');
      const fixture = lastAdminFixture();
      const saveButton = (): HTMLButtonElement => (fixture.nativeElement as HTMLElement)
        .querySelector<HTMLButtonElement>('button[form="productEditorForm"]')!;
      const message = (): string | undefined => (fixture.nativeElement as HTMLElement)
        .querySelector('[data-testid="image-processing-message"]')?.textContent?.trim();
      fixture.detectChanges();
      expect(saveButton().disabled).toBe(false);
      expect(message()).toBeUndefined();

      page.generateAiEnhancedImage();
      fixture.detectChanges();
      expect(page.imageProcessing()).toBe(true);
      expect(saveButton().disabled).toBe(true);
      expect(message()).toBe('Vui lòng chờ hoàn tất xử lý hình ảnh trước khi lưu sản phẩm');

      const submit = new Event('submit', { cancelable: true });
      page.submitEditor(submit);
      expect(page.actionError()).toBe('Vui lòng chờ hoàn tất xử lý hình ảnh trước khi lưu sản phẩm');

      pending.next(enhanceResult()); pending.complete();
      fixture.detectChanges();
      expect(page.imageProcessing()).toBe(false);
      expect(saveButton().disabled).toBe(false);
      expect(message()).toBeUndefined();
    });

    it('treats reading an uploaded file and analyzing it as processing', async () => {
      const page = await createAdminPage(AdminProductsPage);
      grantProductAccess();
      page.imageReading.set(true);
      expect(page.imageProcessing()).toBe(true);
      page.imageReading.set(false);
      page.aiImageBusy.set(true);
      expect(page.imageProcessing()).toBe(true);
      page.aiImageBusy.set(false);
      expect(page.imageProcessing()).toBe(false);
    });
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

  it('applies and resets audit log filters: date range, product, action type and user (3.1.10-05)', async () => {
    let requestedParams: Record<string, string> | undefined;
    const page = await createAdminPage(AdminProductsPage, {
      listProductAuditLogs: (params: Record<string, string>) => {
        requestedParams = params;
        return of({ rows: [], count: 0 });
      },
    });

    page.logsFrom.set('2026-10-01');
    page.logsTo.set('2026-10-19');
    page.logsProduct.set('UAT-Khai');
    page.logsActionType.set('UPDATE_STOCK');
    page.logsUser.set('khai@velura.vn');
    page.applyLogsFilters();

    expect(requestedParams).toEqual({
      limit: '10',
      offset: '0',
      from: '2026-10-01',
      to: '2026-10-19',
      product: 'UAT-Khai',
      actionType: 'UPDATE_STOCK',
      user: 'khai@velura.vn',
    });

    page.resetLogsFilters();
    expect(requestedParams).toEqual({ limit: '10', offset: '0' });
    expect([page.logsFrom(), page.logsTo(), page.logsProduct(), page.logsActionType(), page.logsUser()]).toEqual(['', '', '', '', '']);
  });

  it('rejects a reversed audit date range with a Vietnamese message and sends no request', async () => {
    const listProductAuditLogs = vi.fn(() => of({ rows: [], count: 0 }));
    const page = await createAdminPage(AdminProductsPage, { listProductAuditLogs });
    page.logsFrom.set('2026-10-19');
    page.logsTo.set('2026-10-01');
    page.applyLogsFilters();
    expect(listProductAuditLogs).not.toHaveBeenCalled();
    expect(page.logsError()).toBe('Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.');
  });

  it('renders the audit filters and a detail view with time, actor email, action type, before/after and reason', async () => {
    const row = {
      audit_id: 'a1', timestamp: '2026-10-19T03:00:00Z', action: 'update', action_type: 'UPDATE_STATUS',
      action_label: 'Đổi trạng thái', actor_label: 'Khải (khai@velura.vn)', actor_email: 'khai@velura.vn',
      change_summary: 'Ngừng kinh doanh → Đang bán', reason: 'Bán lại sau kiểm kê',
      old_value: { status: 'discontinued' }, new_value: { status: 'on_sale' },
    };
    const page = await createAdminPage(AdminProductsPage, { listProductAuditLogs: () => of({ rows: [row], count: 1 }) });
    grantProductAccess();
    page.setTab('logs');
    const fixture = lastAdminFixture();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const names = Array.from(root.querySelectorAll('[data-testid="audit-filters"] input[name], [data-testid="audit-filters"] select[name]')).map((el) => el.getAttribute('name'));
    expect(names).toEqual(['from', 'to', 'product', 'actionType', 'user']);
    const options = Array.from(root.querySelectorAll('[data-testid="audit-filters"] select[name="actionType"] option')).map((el) => (el as HTMLOptionElement).value);
    expect(options).toEqual(['', 'CREATE', 'UPDATE', 'UPDATE_STATUS', 'UPDATE_STOCK']);

    page.openLogDetail(row);
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="log-actor-email"]')?.textContent).toContain('khai@velura.vn');
    expect(root.querySelector('[data-testid="log-action-type"]')?.textContent).toContain('UPDATE_STATUS');
    expect(root.querySelector('[data-testid="log-reason"]')?.textContent).toContain('Bán lại sau kiểm kê');
    expect(root.querySelector('[data-testid="log-change"]')?.textContent).toContain('Ngừng kinh doanh → Đang bán');
    expect(root.textContent).toContain('Giá trị trước khi đổi');
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

  describe('UAT 3.1.10 catalog management', () => {
    const skuMessage = 'Mã SKU đã tồn tại, SKU phải là duy nhất trên toàn hệ thống';
    /** The create form only accepts images carrying a live studio approval; paste-by-URL is rejected before SKU checks. */
    const approveEditorImage = (page: AdminProductsPage, url: string): void => {
      page.editorImages.set([url]);
      page.imageApprovals.set([{
        approvalId: 'appr-1', url, sourceRevision: 'rev-1', processingVersion: 'v1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }]);
    };
    const variant = (overrides: Partial<AdminProductVariant> = {}): AdminProductVariant => ({
      variant_id: 'v-den', color: 'Đen', size: 'M', stock_quantity: 50, low_stock_threshold: 5, version: 3, ...overrides,
    });

    it('moves a discontinued product back to on_sale through the versioned status call (3.1.10-01)', async () => {
      const changeProductStatus = vi.fn(() => of({}));
      const page = await createAdminPage(AdminProductsPage, { changeProductStatus });
      grantProductAccess();
      page.openStatus({ product_id: 'p1', name: 'Áo', sku: 'VL-AO001', version: 7, status: 'discontinued' });
      expect(page.nextStatus()).toBe('on_sale');
      expect(page.allowedStatuses().map((row) => row.value)).toEqual(['on_sale', 'hidden', 'out_of_stock']);
      const form = document.createElement('form');
      form.innerHTML = '<input name="status" value="on_sale"><textarea name="reason">Bán lại sau khi nhập hàng mới</textarea>';
      page.submitStatus({ preventDefault: () => undefined, target: form } as unknown as Event);
      expect(changeProductStatus).toHaveBeenCalledWith('p1', { status: 'on_sale', reason: 'Bán lại sau khi nhập hàng mới', expectedVersion: 7 });
    });

    it('shows the duplicate-SKU message inline for an existing SKU and blocks the form submit (AD_PRODUCT_04)', async () => {
      const checkProductSku = vi.fn((sku: string) => of({ sku, available: sku !== 'VL-AO001', code: sku === 'VL-AO001' ? 'SKU_DUPLICATE' : null, message: null }));
      const createProduct = vi.fn(() => of({}));
      const page = await createAdminPage(AdminProductsPage, { checkProductSku, createProduct });
      grantProductAccess();
      page.openCreate();
      page.onSkuInput({ target: { value: ' vl-ao001 ' } } as unknown as Event);
      await vi.waitFor(() => expect(page.skuMessage()).toBe(skuMessage));
      expect(checkProductSku).toHaveBeenCalledWith('VL-AO001');
      const fixture = lastAdminFixture();
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="sku-error"]')?.textContent?.trim()).toBe(skuMessage);

      const form = document.createElement('form');
      form.innerHTML = '<input name="name" value="Áo mới"><input name="sku" value="VL-AO001"><select name="categoryId"><option value="c1" selected>Áo</option></select>';
      approveEditorImage(page, '/assets/a.jpg');
      page.submitEditor({ preventDefault: () => undefined, target: form } as unknown as Event);
      expect(page.actionError()).toBe(skuMessage);
      expect(createProduct).not.toHaveBeenCalled();
    });

    it('clears the inline SKU message once the SKU is free and flags duplicate variant SKUs inside the form', async () => {
      const page = await createAdminPage(AdminProductsPage, {
        checkProductSku: (sku: string) => of({ sku, available: true, code: null, message: null }),
      });
      grantProductAccess();
      page.openCreate();
      page.onSkuInput({ target: { value: 'VL-NEW001' } } as unknown as Event);
      await vi.waitFor(() => expect(page.skuMessage()).toBeNull());
      page.createVariants.set([
        { sku: 'VL-NEW001-DEN-S', color: 'Đen', colorHex: '#000000', size: 'S', stockQuantity: 1, lowStockThreshold: 5 },
        { sku: 'vl-new001-den-s', color: 'Den', colorHex: '#000000', size: 'S', stockQuantity: 1, lowStockThreshold: 5 },
      ]);
      expect(page.variantSkuMessage()).toBe(`${skuMessage} (VL-NEW001-DEN-S)`);
    });

    it('shows the server duplicate-SKU message on the SKU field after a rejected create', async () => {
      const createProduct = vi.fn(() => throwError(() => new HttpErrorResponse({ status: 409, error: { error: { code: 'SKU_DUPLICATE', message: skuMessage } } })));
      const page = await createAdminPage(AdminProductsPage, {
        checkProductSku: (sku: string) => of({ sku, available: true, code: null, message: null }),
        createProduct,
      });
      grantProductAccess();
      page.openCreate();
      const form = document.createElement('form');
      form.innerHTML = '<input name="name" value="Áo mới"><input name="sku" value="VL-RACE01"><select name="categoryId"><option value="c1" selected>Áo</option></select><input name="basePrice" value="1000">';
      approveEditorImage(page, '/assets/a.jpg');
      page.submitEditor({ preventDefault: () => undefined, target: form } as unknown as Event);
      expect(createProduct).toHaveBeenCalled();
      expect(page.actionError()).toBe(skuMessage);
      expect(page.skuMessage()).toBe(skuMessage);
    });

    it('lets CSV preview warn about skipped prices without blocking import, and reports them in the result (AD_PRODUCT_16)', async () => {
      const warning = { row: 2, field: 'base_price', message: 'Giá gốc trong CSV (199.000đ) khác giá hiện tại (250.000đ); giữ nguyên 250.000đ' };
      const commitCsv = vi.fn(() => of({ failed: 0, updated: 1, warnings: [warning], skippedPrices: 1 }));
      const page = await createAdminPage(AdminProductsPage, {
        previewCsv: () => of({ rows: [{ sku: 'VL-AO001', base_price: 250000, skipped_prices: ['base_price'] }], errors: [], warnings: [warning], validRows: 1, totalRows: 1 }),
        commitCsv,
      });
      grantProductAccess();
      await chooseCsv(page, 'sku,name,base_price,category_id\nVL-AO001,Áo,199000,c1');
      expect(page.csvWarnings()).toEqual([warning]);
      expect(page.csvPriceSkipped(page.csvRows()[0])).toBe(true);
      expect(page.canCommitCsv()).toBe(true);
      expect(page.csvMessage()).toContain('giá hiện có được giữ nguyên');
      const fixture = lastAdminFixture();
      page.setTab('csv');
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="csv-warnings"]')?.textContent).toContain('250.000đ');
      page.commitCsv();
      expect(commitCsv).toHaveBeenCalledTimes(1);
      expect(page.csvMessage()).toBe('Đã ghi CSV vào catalog. 1 giá khác giá hiện tại đã được bỏ qua, giá hiện có được giữ nguyên.');
      expect(page.csvWarnings()).toEqual([warning]);
    });

    it('keeps the confirm button disabled while duplicate SKU rows are reported (AD_PRODUCT_15)', async () => {
      const page = await createAdminPage(AdminProductsPage, {
        previewCsv: () => of({
          rows: [], validRows: 0, totalRows: 2, warnings: [],
          errors: [{ row: 2, field: 'sku', message: 'SKU VL-DUP001 bị lặp trong file' }, { row: 3, field: 'sku', message: 'SKU VL-DUP001 bị lặp trong file' }],
        }),
      });
      grantProductAccess();
      await chooseCsv(page, 'sku,name\nVL-DUP001,Áo\nVL-DUP001,Áo khác');
      page.setTab('csv');
      const fixture = lastAdminFixture();
      fixture.detectChanges();
      const confirm = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Ghi CSV vào catalog'));
      expect(confirm?.disabled).toBe(true);
      expect(page.csvErrors().map((error) => error.row)).toEqual([2, 3]);
    });

    it('shows a Sắp hết badge, filters by low stock and lists products below threshold (TH6)', async () => {
      const listProducts = vi.fn(() => of({
        rows: [
          { product_id: 'p1', name: 'Áo thấp', sku: 'VL-AO001', status: 'on_sale', variants: [variant({ stock_quantity: 3 })] },
          { product_id: 'p2', name: 'Áo đủ', sku: 'VL-AO002', status: 'on_sale', variants: [variant({ variant_id: 'v2', stock_quantity: 40 })] },
        ], count: 2,
      }));
      const page = await createAdminPage(AdminProductsPage, {
        listProducts,
        listLowStock: () => of({ rows: [{ variant_id: 'v-den', product_id: 'p1', product_name: 'Áo thấp', color: 'Đen', size: 'M', stock_quantity: 3, low_stock_threshold: 5 }], count: 1 }),
      });
      grantProductAccess();
      page.reloadCatalog();
      const fixture = lastAdminFixture();
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelectorAll('[data-testid="low-stock-badge"]').length).toBe(1);
      expect(page.lowStockCount()).toBe(1);
      expect(root.querySelector('[data-testid="low-stock-list"]')?.textContent).toContain('Áo thấp');
      expect(root.querySelector('[data-testid="low-stock-list"]')?.textContent).toContain('còn 3, ngưỡng 5');

      page.toggleLowStockFilter();
      expect(page.lowStockOnly()).toBe(true);
      // The KPI count requests (on_sale, hidden, out_of_stock) are issued after the list, so assert the list call itself.
      expect(listProducts).toHaveBeenCalledWith(expect.objectContaining({ lowStock: 'true' }));
      page.resetFilters(new Event('reset', { cancelable: true }));
      expect(page.lowStockOnly()).toBe(false);
    });

    it('lets the admin reduce stock below the threshold and keeps the on-screen alert even if the alert email failed (TH6)', async () => {
      const alert = {
        productId: 'p1', variantId: 'v-den', productName: 'Áo thấp', sku: 'VL-AO001', color: 'Đen', size: 'M', stock: 3, threshold: 5,
        emailQueued: false, retryRecorded: true,
        message: 'Cảnh báo tồn kho thấp: Áo thấp (Đen / M) còn 3, ngưỡng tối thiểu 5. Email cảnh báo chưa gửi được và đã lưu để thử lại.',
      };
      const updateStock = vi.fn(() => of({ lowStockAlert: alert }));
      const page = await createAdminPage(AdminProductsPage, { updateStock });
      grantProductAccess();
      const product: AdminProductRow = { product_id: 'p1', name: 'Áo thấp', sku: 'VL-AO001', status: 'on_sale', variants: [variant()] };
      page.openStock(product);
      page.setStockAdjustmentType('out');
      page.stockAdjustmentQuantity.set(47);
      page.stockReason.set('Kiểm kê giảm tồn xuống dưới ngưỡng');
      expect(page.projectedStock()).toBe(3);
      expect(page.projectedBelowThreshold()).toBe(true);
      page.submitStock({ preventDefault: () => undefined } as unknown as Event);
      expect(updateStock).toHaveBeenCalledWith('p1', { variantId: 'v-den', delta: -47, reason: 'Kiểm kê giảm tồn xuống dưới ngưỡng', expectedVersion: 3 });
      expect(page.stockAlert()?.message).toContain('đã lưu để thử lại');
      const fixture = lastAdminFixture();
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="stock-alert"]')?.textContent).toContain('còn 3, ngưỡng tối thiểu 5');
    });

    it('rejects too-short reasons and outbound stock above the stock on hand with Vietnamese messages before any request', async () => {
      const updateStock = vi.fn(() => of({}));
      const page = await createAdminPage(AdminProductsPage, { updateStock });
      grantProductAccess();
      page.openStock({ product_id: 'p1', name: 'Áo', sku: 'VL-AO001', status: 'on_sale', variants: [variant()] });
      page.setStockAdjustmentType('out');
      page.stockAdjustmentQuantity.set(60);
      page.stockReason.set('Kiểm kê định kỳ cuối tháng');
      page.submitStock({ preventDefault: () => undefined } as unknown as Event);
      expect(page.actionError()).toBe('Không thể xuất quá tồn hiện có (50 sản phẩm).');
      page.stockAdjustmentQuantity.set(10);
      page.stockReason.set('ngắn');
      page.submitStock({ preventDefault: () => undefined } as unknown as Event);
      expect(page.actionError()).toBe('Vui lòng nhập lý do điều chỉnh tối thiểu 10 ký tự.');
      expect(updateStock).not.toHaveBeenCalled();
    });
  });
});
