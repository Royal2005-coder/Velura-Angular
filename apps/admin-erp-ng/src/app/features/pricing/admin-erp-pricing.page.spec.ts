import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { AdminErpApiService, AdminPriceHistoryRow, AdminProductRow } from '../../core/admin-erp-api.service';
import { AdminListPayload } from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { AdminErpPricingPage } from './admin-erp-pricing.page';

const products: AdminProductRow[] = [
  {
    product_id: 'p1',
    name: 'Lụa Hà Nội',
    sku: 'VL-01',
    base_price: 1_000_000,
    sale_price: 800_000,
    version: 2,
    status: 'on_sale',
    category: { name: 'Áo' },
    updated_at: '2026-10-20T03:00:00Z',
  },
  {
    product_id: 'p2',
    name: 'Áo dài',
    sku: 'VL-02',
    base_price: 900_000,
    sale_price: 950_000,
    version: 1,
    status: 'hidden',
    category: { name: 'Áo dài' },
  },
  {
    product_id: 'p3',
    name: 'Váy lụa',
    sku: 'VL-03',
    base_price: 700_000,
    sale_price: null,
    version: 1,
    status: 'on_sale',
  },
];

type ListProductsFn = (params?: Record<string, string>) => Observable<AdminListPayload<AdminProductRow>>;

describe('AdminErpPricingPage', () => {
  async function boot(listProducts: ListProductsFn, calls: Array<Record<string, string> | undefined> = []) {
    TestBed.resetTestingModule();
    const changes: Array<{ productId: string; body: Record<string, unknown> }> = [];
    const api = {
      listPricingProducts: (params?: Record<string, string>) => {
        calls.push(params);
        return listProducts(params);
      },
      listPriceHistory: () => of({ rows: [] as AdminPriceHistoryRow[], count: 0 }),
      listPricingAuditLogs: () => of({ rows: [], count: 0 }),
      changePrice: (productId: string, body: Record<string, unknown>) => {
        changes.push({ productId, body });
        return of(products[0]);
      },
    };
    await TestBed.configureTestingModule({
      imports: [AdminErpPricingPage],
      providers: [provideRouter([]), { provide: AdminErpApiService, useValue: api }],
    }).compileComponents();
    const session = TestBed.inject(AdminErpSessionService);
    session.applyAuthContext({
      role: 'admin_operator_gia_km',
      roleName: 'Admin giá',
      isAdmin: true,
      allowedPages: ['pricing'],
      allowedModules: ['pricing'],
      capabilities: { pricing: ['read', 'update'] },
      user: { id: 'price', email: 'price@velura.test' },
      profile: { user_id: 'price', email: 'price@velura.test', full_name: 'Price', is_active: true },
    });
    const fixture = TestBed.createComponent(AdminErpPricingPage);
    fixture.detectChanges();
    return { fixture, changes };
  }

  it('loads products and computes price warnings', async () => {
    const { fixture } = await boot(() => of({ rows: products, count: 3 }));
    const page = fixture.componentInstance;

    expect(page.products().length).toBe(3);
    expect(page.total()).toBe(3);
    expect(page.missingSale()).toBe(1);
    expect(page.discounted()).toBe(1);
    expect(page.invalid()).toBe(1);
    expect(page.canMutate()).toBe(true);
  });

  it('sends search and product status to the server', async () => {
    const calls: Array<Record<string, string> | undefined> = [];
    const { fixture } = await boot(() => of({ rows: products, count: 3 }), calls);
    const page = fixture.componentInstance;

    page.query.set('lua');
    page.status.set('on_sale');
    page.applyFilters();

    const last = calls.at(-1);
    expect(last?.['q']).toBe('lua');
    expect(last?.['status']).toBe('on_sale');
  });

  it('sends the derived price state to the server instead of filtering one page', async () => {
    const calls: Array<Record<string, string> | undefined> = [];
    const { fixture } = await boot((params) => {
      const state = params?.['price_state'];
      const rows = state === 'invalid' ? [products[1]] : state === 'missing_sale' ? [products[2]] : products;
      return of({ rows, count: rows.length });
    }, calls);
    const page = fixture.componentInstance;

    page.onPriceStateChange({ target: { value: 'invalid' } } as unknown as Event);
    page.applyFilters();
    expect(calls.at(-1)?.['price_state']).toBe('invalid');
    expect(page.filtered().map((row) => row.product_id)).toEqual(['p2']);

    page.onPriceStateChange({ target: { value: 'missing' } } as unknown as Event);
    page.applyFilters();
    expect(calls.at(-1)?.['price_state']).toBe('missing_sale');
    expect(page.filtered().map((row) => row.product_id)).toEqual(['p3']);
  });

  it('opens the price drawer and previews a change', async () => {
    const { fixture } = await boot(() => of({ rows: products, count: 3 }));
    const page = fixture.componentInstance;

    page.openDetail(products[0]);
    expect(page.selected()?.product_id).toBe('p1');

    page.openChange();
    expect(page.actionOpen()).toBe(true);
    page.previewBase.set(1_000_000);
    page.previewSale.set(800_000);
    expect(page.previewPct()).toBe(20);
  });

  it('submits a price change with expectedVersion', async () => {
    const { fixture, changes } = await boot(() => of({ rows: products, count: 3 }));
    const page = fixture.componentInstance;
    page.openDetail(products[0]);
    page.openChange();

    const form = document.createElement('form');
    for (const [name, value] of [['basePrice', '1000000'], ['salePrice', '750000'], ['reason', 'Điều chỉnh giá theo kế hoạch tháng mười']]) {
      const input = document.createElement('input');
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    const event = { preventDefault: () => undefined, target: form } as unknown as Event;
    page.submitPrice(event);

    expect(changes.length).toBe(1);
    expect(changes[0].productId).toBe('p1');
    expect(changes[0].body['expectedVersion']).toBe(2);
    expect(changes[0].body['newSalePrice']).toBe(750_000);
  });

  it('surfaces pricing API errors', async () => {
    const { fixture } = await boot(() => throwError(() => new Error('pricing down')));
    const page = fixture.componentInstance;

    expect(page.loadError()).toBe('pricing down');
    expect(page.products()).toEqual([]);
  });
});
