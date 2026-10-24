import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import {
  AdminErpApiService,
  AdminProductCreateInput,
  AdminProductRow,
  AdminProductUpdateInput,
  AdminProductVariant,
  AdminSkuCheck,
} from '../../core/admin-erp-api.service';
import { ProductEditorComponent } from './product-editor.component';

const saved: AdminProductRow = {
  product_id: 'p1',
  name: 'Áo khoác lụa',
  sku: 'VL-AO001',
  category_id: 'c1',
  base_price: 1_200_000,
  sale_price: 980_000,
  status: 'on_sale',
  version: 4,
  images: ['/assets/images/a.jpg'],
  variants: [{ variant_id: 'v1', color: 'Đen', size: 'M', stock_quantity: 3, version: 2 } as AdminProductVariant],
};

const free = (sku: string): AdminSkuCheck => ({ sku, available: true, code: null, message: null });

describe('ProductEditorComponent', () => {
  function boot(api: Partial<AdminErpApiService>, canChangePrice = false) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ProductEditorComponent],
      providers: [{ provide: AdminErpApiService, useValue: api }],
    });
    const fixture = TestBed.createComponent(ProductEditorComponent);
    fixture.componentRef.setInput('canChangePrice', canChangePrice);
    return fixture;
  }

  function open(fixture: ReturnType<typeof boot>, product: AdminProductRow | null): ProductEditorComponent {
    fixture.componentRef.setInput('product', product);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  it('creates a product with its variant matrix and version 0', () => {
    const payloads: AdminProductCreateInput[] = [];
    const fixture = boot({
      createProduct: (body: AdminProductCreateInput) => {
        payloads.push(body);
        return of(saved);
      },
      checkProductSku: (sku: string) => of(free(sku)),
    });
    const editor = open(fixture, null);

    editor.name.set('Đầm linen');
    editor.sku.set('vl-dam002');
    editor.categoryId.set('c1');
    editor.basePrice.set(800_000);
    editor.salePrice.set(700_000);
    editor.colorsInput.set('Đen, Trắng');
    editor.sizesInput.set('S, M');
    editor.regenerateMatrix();
    editor.images.set(['/assets/images/dam.jpg']);
    editor.submit();

    expect(payloads.length).toBe(1);
    const body = payloads[0];
    expect(body.sku).toBe('VL-DAM002');
    expect(body.slug).toBe('dam-linen');
    expect(body.status).toBe('on_sale');
    expect(body.expectedVersion).toBe(0);
    expect(body.variants?.length).toBe(4);
    expect(body.initialStock).toBe(40);
    expect(body.images).toEqual(['/assets/images/dam.jpg']);
  });

  it('refuses to create when a variant SKU already exists in the catalog', () => {
    const fixture = boot({
      createProduct: () => of(saved),
      checkProductSku: (sku: string) =>
        of(
          sku === 'VL-DAM001-DEN-S'
            ? { sku, available: false, code: 'SKU_DUPLICATE' as const, message: 'duplicate' }
            : free(sku),
        ),
    });
    const editor = open(fixture, null);
    editor.name.set('Đầm');
    editor.categoryId.set('c1');
    editor.images.set(['/assets/images/dam.jpg']);
    editor.matrix.update((rows) => rows.map((row, index) => (index === 0 ? { ...row, sku: 'VL-DAM001-DEN-S' } : row)));
    editor.verifySkus();

    expect(editor.variantSkuMessage()).toContain('VL-DAM001-DEN-S');
    editor.submit();
    expect(editor.error()).toContain('VL-DAM001-DEN-S');
  });

  it('patches catalog details only, leaving price and status out of the payload', () => {
    const patches: AdminProductUpdateInput[] = [];
    const fixture = boot({
      updateProduct: (_id: string, body: AdminProductUpdateInput) => {
        patches.push(body);
        return of(saved);
      },
      checkProductSku: (sku: string) => of(free(sku)),
    });
    const editor = open(fixture, saved);

    editor.description.set('Chất liệu linen mát.');
    editor.submit();

    const sent = patches[0] as unknown as Record<string, unknown>;
    expect(patches.length).toBe(1);
    expect(sent['expectedVersion']).toBe(4);
    expect(sent['status']).toBeUndefined();
    expect(sent['basePrice']).toBeUndefined();
    expect(sent['salePrice']).toBeUndefined();
    expect(sent['description']).toContain('linen');
  });

  it('writes a price change first and reuses the returned version for the patch', () => {
    const patches: AdminProductUpdateInput[] = [];
    const fixture = boot(
      {
        changePrice: () => of({ ...saved, version: 5, base_price: 1_500_000 }),
        updateProduct: (_id: string, body: AdminProductUpdateInput) => {
          patches.push(body);
          return of(saved);
        },
        checkProductSku: (sku: string) => of(free(sku)),
      },
      true,
    );
    const editor = open(fixture, saved);

    editor.basePrice.set(1_500_000);
    editor.submit();

    expect(patches.length).toBe(1);
    expect(patches[0].expectedVersion).toBe(5);
  });

  it('refuses to move the price without the pricing capability', () => {
    const fixture = boot({
      updateProduct: () => of(saved),
      checkProductSku: (sku: string) => of(free(sku)),
    });
    const editor = open(fixture, saved);

    editor.basePrice.set(1_500_000);
    expect(editor.priceChanged()).toBe(true);
    editor.submit();

    expect(editor.error()).toContain('không có quyền điều chỉnh giá');
  });

  it('blocks saving while a remote image has no server approval', () => {
    const fixture = boot({
      createProduct: () => of(saved),
      checkProductSku: (sku: string) => of(free(sku)),
    });
    const editor = open(fixture, null);

    editor.name.set('Đầm');
    editor.categoryId.set('c1');
    editor.images.set(['https://cdn.example/test.jpg']);

    expect(editor.missingApproval()).toBe(true);
    expect(editor.canSave()).toBe(false);
  });

  it('keeps a version conflict visible and asks the page to reread', () => {
    const conflicts: number[] = [];
    const fixture = boot({
      updateProduct: () =>
        throwError(
          () => new HttpErrorResponse({ status: 409, error: { error: { message: 'Dữ liệu đã đổi; tải lại rồi thử lại' } } }),
        ),
      checkProductSku: (sku: string) => of(free(sku)),
    });
    const editor = open(fixture, saved);
    editor.conflict.subscribe(() => conflicts.push(1));

    editor.submit();

    expect(editor.error()).toContain('tải lại');
    expect(conflicts.length).toBe(1);
  });
});
