import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import {
  AdminAuditRow,
  AdminCategoryRow,
  AdminErpApiService,
  AdminLowStockRow,
  AdminProductRow,
  AdminProductVariant,
} from '../../core/admin-erp-api.service';
import { AdminListPayload } from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { AdminErpProductsPage } from './admin-erp-products.page';

const variant: AdminProductVariant = {
  variant_id: 'v1',
  sku: 'VL-AO001-DEN-M',
  color: 'Đen',
  size: 'M',
  stock_quantity: 2,
  reserved_quantity: 1,
  low_stock_threshold: 5,
  version: 3,
};

const products: AdminProductRow[] = [
  {
    product_id: 'p1',
    name: 'Áo khoác lụa',
    sku: 'VL-AO001',
    base_price: 1_200_000,
    sale_price: 980_000,
    status: 'on_sale',
    category_id: 'c1',
    category: { name: 'Áo khoác' },
    version: 4,
    images: ['/assets/images/ao-1.jpg'],
    variants: [variant],
    updated_at: '2026-10-20T03:00:00Z',
  },
  {
    product_id: 'p2',
    name: 'Váy bút chì',
    sku: 'VL-VE002',
    base_price: 900_000,
    status: 'hidden',
    category_id: 'c2',
    is_combo: true,
    version: 1,
    variants: [{ ...variant, variant_id: 'v2', stock_quantity: 0 }],
  },
];

const lowStock: AdminLowStockRow[] = [
  {
    variant_id: 'v1',
    product_id: 'p1',
    product_name: 'Áo khoác lụa',
    product_sku: 'VL-AO001',
    product_status: 'on_sale',
    color: 'Đen',
    size: 'M',
    stock_quantity: 2,
    low_stock_threshold: 5,
    shortage: 3,
    out_of_stock: false,
  },
];

type ListFn = (params?: Record<string, string>) => Observable<AdminListPayload<AdminProductRow>>;

describe('AdminErpProductsPage', () => {
  async function boot(
    listProducts: ListFn = () => of({ rows: products, count: 2 }),
    options: { role?: string; capabilities?: Record<string, string[]>; listError?: boolean } = {},
  ) {
    TestBed.resetTestingModule();
    const calls: Array<Record<string, string> | undefined> = [];
    const statusCalls: Array<{ productId: string; body: Record<string, unknown> }> = [];
    const priceCalls: Array<{ productId: string; body: Record<string, unknown> }> = [];
    const api = {
      listProducts: (params?: Record<string, string>) => {
        calls.push(params);
        if (options.listError) {
          return throwError(() => new Error('catalog down'));
        }
        const status = params?.['status'];
        if (status === 'on_sale') {
          return of({ rows: [products[0]], count: 9 });
        }
        if (status === 'hidden') {
          return of({ rows: [products[1]], count: 4 });
        }
        if (status === 'out_of_stock') {
          return of({ rows: [], count: 2 });
        }
        if (params?.['lowStock'] === 'true') {
          return of({ rows: [], count: 1 });
        }
        return listProducts(params);
      },
      listCategories: () => of({ rows: [{ category_id: 'c1', name: 'Áo khoác' }] as AdminCategoryRow[], count: 1 }),
      listLowStock: () => of({ data: lowStock }),
      getProduct: (id: string) => of(products.find((row) => row.product_id === id) || products[0]),
      listVariants: () => of({ data: { rows: [variant], count: 1 } }),
      changeProductStatus: (productId: string, body: Record<string, unknown>) => {
        statusCalls.push({ productId, body });
        return of({ ...products[0], status: String(body['status']) });
      },
      changePrice: (productId: string, body: Record<string, unknown>) => {
        priceCalls.push({ productId, body });
        return of(products[0]);
      },
      listProductAuditLogs: () => of({ rows: [] as AdminAuditRow[], count: 0 }),
    };
    await TestBed.configureTestingModule({
      imports: [AdminErpProductsPage],
      providers: [provideRouter([]), { provide: AdminErpApiService, useValue: api }],
    }).compileComponents();
    TestBed.inject(AdminErpSessionService).applyAuthContext({
      role: options.role || 'admin_operator_sanpham',
      roleName: 'Thủ kho',
      isAdmin: true,
      allowedPages: ['products', 'pricing'],
      allowedModules: ['products', 'pricing'],
      capabilities: options.capabilities || { products: ['read', 'create', 'update'], pricing: ['read', 'update'] },
      user: { id: 'u1', email: 'staff@velura.test' },
      profile: { user_id: 'u1', email: 'staff@velura.test', full_name: 'Staff', is_active: true },
    });
    const fixture = TestBed.createComponent(AdminErpProductsPage);
    fixture.detectChanges();
    await fixture.whenStable();
    return { fixture, calls, statusCalls, priceCalls };
  }

  it('loads the catalog with server KPI counts and variant stock', async () => {
    const { fixture } = await boot();
    const page = fixture.componentInstance;

    expect(page.products().length).toBe(2);
    expect(page.total()).toBe(2);
    expect(page.onSale()).toBe(9);
    expect(page.hidden()).toBe(4);
    expect(page.outOfStock()).toBe(2);
    expect(page.lowStockCount()).toBe(1);
    expect(page.pageStock()).toBe(2);
    expect(page.canWrite()).toBe(true);
    expect(page.canCreate()).toBe(true);
  });

  it('reports a catalog load failure without clearing the KPI frame', async () => {
    const { fixture } = await boot(undefined, { listError: true });
    const page = fixture.componentInstance;

    expect(page.loadError()).toBe('catalog down');
    expect(page.products()).toEqual([]);
    expect(page.loading()).toBe(false);
  });

  it('sends every catalog filter to the list API', async () => {
    const { fixture, calls } = await boot(() => of({ rows: products, count: 30 }));
    const page = fixture.componentInstance;

    page.query.set('lua');
    page.categoryId.set('c1');
    page.status.set('on_sale');
    page.order.set('name.asc');
    page.lowStockOnly.set(true);
    page.goPage(3);

    const filtered = calls.filter((params) => params?.['q'] === 'lua');
    expect(filtered.length).toBeGreaterThan(0);
    const last = filtered.at(-1);
    expect(last?.['categoryId']).toBe('c1');
    expect(last?.['order']).toBe('name.asc');
    expect(last?.['lowStock']).toBe('true');
    expect(last?.['limit']).toBe('12');
    expect(last?.['offset']).toBe('24');
  });

  it('opens the drawer from a low-stock row and rereads variants', async () => {
    const { fixture } = await boot();
    const page = fixture.componentInstance;

    page.setTab('stock');
    fixture.detectChanges();
    expect(page.tab()).toBe('stock');

    page.openLowStockDetail(lowStock[0]);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(page.selected()?.product_id).toBe('p1');
    expect(page.variants().length).toBe(1);
    expect(page.selectedVariants().length).toBe(1);
    expect(page.stockOf(page.selected() || products[0])).toBe(2);
  });

  it('rejects a short status reason and otherwise writes with expectedVersion', async () => {
    const { fixture, statusCalls } = await boot();
    const page = fixture.componentInstance;
    page.openDetail(products[0]);

    page.openStatus();
    expect(page.allowedStatuses().map((option) => option.value)).toEqual(['hidden', 'out_of_stock', 'discontinued']);

    const form = (reason: string): Event => {
      const element = document.createElement('form');
      const textarea = document.createElement('textarea');
      textarea.name = 'reason';
      textarea.value = reason;
      element.appendChild(textarea);
      return { preventDefault: () => undefined, target: element } as unknown as Event;
    };

    page.submitStatus(form('ngắn'));
    expect(page.statusError()).toContain('10 ký tự');
    expect(statusCalls.length).toBe(0);

    page.submitStatus(form('Ngừng bán tạm thời chờ bổ sung ảnh'));
    expect(statusCalls.length).toBe(1);
    expect(statusCalls[0].productId).toBe('p1');
    expect(statusCalls[0].body['expectedVersion']).toBe(4);
    expect(statusCalls[0].body['status']).toBe('hidden');
  });

  it('writes a price change bound to the version the operator is looking at', async () => {
    const { fixture, priceCalls } = await boot();
    const page = fixture.componentInstance;
    page.openDetail(products[0]);
    page.openPrice();

    const form = document.createElement('form');
    for (const [name, value] of [
      ['basePrice', '1200000'],
      ['salePrice', '990000'],
      ['reason', 'Điều chỉnh giá theo đợt sale tháng mười'],
    ]) {
      const input = document.createElement('input');
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    page.submitPrice({ preventDefault: () => undefined, target: form } as unknown as Event);

    expect(priceCalls.length).toBe(1);
    expect(priceCalls[0].body['newSalePrice']).toBe(990_000);
    expect(priceCalls[0].body['expectedVersion']).toBe(4);
  });

  it('hides every write affordance for a read-only reviewer', async () => {
    const { fixture } = await boot(undefined, {
      role: 'admin_viewer',
      capabilities: { products: ['read'] },
    });
    const page = fixture.componentInstance;

    expect(page.canWrite()).toBe(false);
    expect(page.canCreate()).toBe(false);
    page.openCreate();
    expect(page.editorProduct()).toBeUndefined();
    page.openStock();
    expect(page.stockOpen()).toBe(false);
  });
});
