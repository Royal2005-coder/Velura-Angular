import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { AdminErpApiService, AdminOrderRow, AdminOrderSummary } from '../../core/admin-erp-api.service';
import { AdminListPayload } from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { AdminErpOrdersPage } from './admin-erp-orders.page';

const paidOrder: AdminOrderRow = {
  order_id: 'o1',
  order_code: 'VL-1001',
  order_date: '2026-10-20T03:00:00Z',
  status: 'processing',
  status_label: 'Đang chuẩn bị hàng',
  payment_method: 'ONLINE_PAYMENT',
  payment_status: 'paid',
  payment_status_label: 'Đã thanh toán',
  shipping_name: 'Nguyễn An',
  shipping_phone: '0901234567',
  total_amount: 1_200_000,
  subtotal: 1_200_000,
  version: 3,
  allowed_actions: [
    { code: 'start_processing', label: 'Bắt đầu chuẩn bị', to_status: 'processing', requires_note: false, fields: [], destructive: false },
  ],
  items: [{ product_name: 'Lụa Hà Nội', quantity: 1, unit_price: 1_200_000 }],
  events: [],
};

const codOrder: AdminOrderRow = {
  ...paidOrder,
  order_id: 'o2',
  order_code: 'VL-1002',
  status: 'pending',
  status_label: 'Chờ xác nhận',
  payment_method: 'COD',
  payment_status: 'pending',
  total_amount: 1_500_000,
  allowed_actions: [
    { code: 'call_confirm', label: 'Gọi xác nhận', to_status: null, requires_note: true, fields: ['call_result'], destructive: false },
    { code: 'confirm_cod', label: 'Xác nhận COD', to_status: 'confirmed', requires_note: false, fields: [], destructive: false },
  ],
};

type ListOrdersFn = (params?: Record<string, string>) => Observable<AdminListPayload<AdminOrderRow>>;

describe('AdminErpOrdersPage', () => {
  async function boot(listOrders: ListOrdersFn, calls: Array<Record<string, string> | undefined> = []) {
    TestBed.resetTestingModule();
    const summary: AdminOrderSummary = {
      attention: 3,
      by_status: [
        { status: 'pending', label: 'Chờ xác nhận', count: 3 },
        { status: 'processing', label: 'Đang chuẩn bị hàng', count: 1 },
        { status: 'cancelled', label: 'Đã hủy', count: 2 },
      ],
    };
    const api = {
      listOrders: (params?: Record<string, string>) => {
        calls.push(params);
        return listOrders(params);
      },
      orderSummary: () => of(summary),
      getOrder: (orderId: string) => of(orderId === 'o2' ? codOrder : paidOrder),
      orderAuditLogs: () => of({ rows: [], count: 0 }),
      listAuditLogs: () => of({ rows: [], count: 0 }),
      performOrderAction: () => of({ order: paidOrder, refund: null }),
      resolvePayment: () => of({}),
      simulateCarrier: () => of(paidOrder),
    };
    await TestBed.configureTestingModule({
      imports: [AdminErpOrdersPage],
      providers: [provideRouter([]), { provide: AdminErpApiService, useValue: api }],
    }).compileComponents();
    const session = TestBed.inject(AdminErpSessionService);
    session.applyAuthContext({
      role: 'admin_operator_donhang',
      roleName: 'Admin đơn hàng',
      isAdmin: true,
      allowedPages: ['orders'],
      allowedModules: ['orders'],
      capabilities: { orders: ['read', 'update'] },
      user: { id: 'order', email: 'order@velura.test' },
      profile: { user_id: 'order', email: 'order@velura.test', full_name: 'Order', role: 'admin', is_active: true },
    });
    const fixture = TestBed.createComponent(AdminErpOrdersPage);
    fixture.detectChanges();
    return fixture;
  }

  it('loads orders and summary counts', async () => {
    const fixture = await boot(() => of({ rows: [paidOrder, codOrder], count: 2 }));
    const page = fixture.componentInstance;

    expect(page.rows().length).toBe(2);
    expect(page.count()).toBe(2);
    expect(page.attentionCount()).toBe(3);
    expect(page.cancelledCount()).toBe(2);
    expect(page.canMutate()).toBe(true);
  });

  it('sends order filters to the server', async () => {
    const calls: Array<Record<string, string> | undefined> = [];
    const fixture = await boot(() => of({ rows: [paidOrder], count: 1 }), calls);
    const page = fixture.componentInstance;

    page.query.set('VL-1001');
    page.status.set('processing');
    page.paymentMethod.set('ONLINE_PAYMENT');
    page.from.set('2026-10-01');
    page.applyFilters();

    const last = calls.at(-1);
    expect(last?.['q']).toBe('VL-1001');
    expect(last?.['status']).toBe('processing');
    expect(last?.['paymentMethod']).toBe('ONLINE_PAYMENT');
    expect(last?.['from']).toBe('2026-10-01');
  });

  it('opens a normal order detail and renders its pipeline', async () => {
    const fixture = await boot(() => of({ rows: [paidOrder], count: 1 }));
    const page = fixture.componentInstance;

    page.openRow(paidOrder);
    expect(page.selected()?.order_id).toBe('o1');
    expect(page.pipelineSteps().length).toBeGreaterThan(0);
  });

  it('routes a pending COD order to the call flow and enforces the call guard', async () => {
    const fixture = await boot(() => of({ rows: [codOrder], count: 1 }));
    const page = fixture.componentInstance;

    page.openRow(codOrder);
    expect(page.modal()?.kind).toBe('cod_call');
    expect(page.selected()?.order_id).toBe('o2');
    expect(page.requiresCallConfirmation()).toBe(true);
  });

  it('surfaces order API errors without fabricated rows', async () => {
    const fixture = await boot((params) => {
      if (params?.['limit'] === '1') return of({ rows: [], count: 0 });
      return throwError(() => new Error('orders down'));
    });
    const page = fixture.componentInstance;

    expect(page.loadError()).toBe('orders down');
    expect(page.rows()).toEqual([]);
  });
});
