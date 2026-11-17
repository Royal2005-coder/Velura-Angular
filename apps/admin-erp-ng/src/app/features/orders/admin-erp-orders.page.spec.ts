import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { AdminErpApiService, AdminOrderAction, AdminOrderRow, AdminOrderSummary } from '../../core/admin-erp-api.service';
import { AdminListPayload } from '../../core/admin-erp-http';
import { AdminErpSessionService, type AdminAuthMe } from '../../core/admin-erp-session.service';
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

type ListOrdersFn = (param?: Record<string, string>) => Observable<AdminListPayload<AdminOrderRow>>;

const shipmentAction: AdminOrderAction = {
  code: 'upsert_shipment',
  label: 'Xác nhận vận đơn',
  to_status: null,
  requires_note: true,
  fields: ['shipment'],
  destructive: false,
};

const handoverAction: AdminOrderAction = {
  code: 'confirm_handover',
  label: 'Xác nhận bàn giao ĐVVC',
  to_status: 'shipping',
  requires_note: true,
  fields: [],
  destructive: false,
};

const shippedOrder: AdminOrderRow = {
  ...paidOrder,
  version: 3,
  carrier: 'GHN',
  tracking_code: 'VN9-1',
  allowed_actions: [shipmentAction, handoverAction],
};

const handedOrder: AdminOrderRow = { ...shippedOrder, status: 'shipping', version: 4, allowed_actions: [] };

function formEvent(values: Record<string, string>): Event {
  const elements = { namedItem: (name: string) => ({ value: values[name] ?? '' }) };
  return { preventDefault: () => undefined, target: { elements } } as unknown as Event;
}

function context(capabilities: Record<string, string[]>): AdminAuthMe {
  return {
    role: 'admin_operator_donhang',
    roleName: 'Admin đơn hàng',
    isAdmin: true,
    allowedPages: ['orders'],
    allowedModules: ['orders'],
    capabilities,
    user: { id: 'order', email: 'order@velura.test' },
    profile: { user_id: 'order', email: 'order@velura.test', full_name: 'Order', role: 'admin', is_active: true },
  } as AdminAuthMe;
}

describe('AdminErpOrdersPage', () => {
  async function boot(
    listOrders: ListOrdersFn,
    calls: Array<Record<string, string> | undefined> = [],
    overrides: Record<string, unknown> = {},
    capabilities: Record<string, string[]> = { orders: ['read', 'update'] },
  ) {
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
      listReturns: () => of({ rows: [], count: 0 }),
      performOrderAction: () => of({ order: paidOrder, refund: null }),
      resolvePayment: () => of({}),
      uploadOrderEvidence: () =>
        of({ evidence_id: 'e-default', stage: 'processing', kind: 'image', url: 'https://signed', created_at: '2026-10-23T02:00:00Z' }),
      simulateCarrier: () => of(paidOrder),
      getOrderCarrierLabel: (orderId: string) =>
        of({
          order_id: orderId,
          order_code: 'VL-1001',
          carrier: 'GHN',
          trackingCode: 'GHNVL1001',
          trackingUrl: 'https://donhang.ghn.vn/?order_code=GHNVL1001',
          labelQr: 'velura:shipment:1?order=VL-1001&carrier=GHN&tracking=GHNVL1001',
        }),
      ...overrides,
    };
    await TestBed.configureTestingModule({
      imports: [AdminErpOrdersPage],
      providers: [provideRouter([]), { provide: AdminErpApiService, useValue: api }],
    }).compileComponents();
    const session = TestBed.inject(AdminErpSessionService);
    session.applyAuthContext(context(capabilities));
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

    page.openRowAction(codOrder, 'call_confirm');
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

  it('runs the handover the API keeps as a second action right after the shipment is stored', async () => {
    const actions: Array<{ action: string; body: Record<string, unknown> }> = [];
    const fixture = await boot(
      () => of({ rows: [shippedOrder], count: 1 }),
      [],
      {
        performOrderAction: (orderId: string, action: string, body: Record<string, unknown>) => {
          actions.push({ action, body });
          return of({ order: action === 'upsert_shipment' ? shippedOrder : handedOrder, refund: null });
        },
      },
    );
    const page = fixture.componentInstance;

    page.selected.set(shippedOrder);
    page.applyShipmentScan('GHN123456789');
    page.shipmentPhoto.set(new File(['x'], 'kien-hang.png', { type: 'image/png' }));
    page.modal.set({ kind: 'action', action: shipmentAction });
    page.submitAction(formEvent({ note: 'Xác nhận vận đơn GHN123456789' }));

    expect(actions.map((entry) => entry.action)).toEqual(['upsert_shipment', 'confirm_handover']);
    expect(actions[0].body['expectedVersion']).toBe(3);
    expect(actions[1].body['expectedVersion']).toBe(3);
    expect(actions[0].body['trackingCode']).toBe('GHN123456789');
    expect(String(actions[1].body['note'])).toContain('GHN123456789');
    expect(page.selected()?.status).toBe('shipping');
    expect(page.notice()).toContain('bàn giao');
  });

  it('fills the shipment from a scanned carrier label and freezes the fields', async () => {
    const fixture = await boot(() => of({ rows: [shippedOrder], count: 1 }));
    const page = fixture.componentInstance;
    page.selected.set(shippedOrder);

    page.applyShipmentScan('GHN123456789');
    expect(page.shipment().trackingCode).toBe('GHN123456789');
    expect(page.scanError()).toBeNull();
    expect(page.scanLocked()?.trackingCode).toBe('GHN123456789');

  });

  it('refuses a label that belongs to another order', async () => {
    const fixture = await boot(() => of({ rows: [shippedOrder], count: 1 }));
    const page = fixture.componentInstance;
    page.selected.set(shippedOrder);

    page.applyShipmentScan('velura:shipment:1?order=VLR-OTHER&carrier=GHN&tracking=GHN-OTHER');
    expect(page.scanError()).toContain('đơn khác');
    expect(page.shipment().trackingCode).toBe('');
  });

  it('loads the shipment of this order from the sample label QR but refuses the plain order QR', async () => {
    const fixture = await boot(() => of({ rows: [paidOrder], count: 1 }));
    const page = fixture.componentInstance;
    page.selected.set(paidOrder);

    page.applyShipmentScan(page.scanSample());
    expect(page.shipment().carrier).toBe('GHN');
    expect(page.shipment().trackingCode).toBe('GHNVL1001');
    expect(page.shipment().trackingUrl).toContain('donhang.ghn.vn');
    expect(page.scanNotice()).toContain('Đã khóa');

    page.scanLocked.set(null);
    page.shipment.set({ carrier: '', trackingCode: '', trackingUrl: '' });
    page.applyShipmentScan('http://localhost/orders?focus=o1&code=VL-1001');
    expect(page.shipment().trackingCode).toBe('');
    expect(page.scanLocked()).toBeNull();
    expect(page.scanError()).toContain('nhãn vận đơn');
  });

  it('routes call_confirm through the COD call flow instead of the generic form', async () => {
    const fixture = await boot(() => of({ rows: [codOrder], count: 1 }));
    const page = fixture.componentInstance;
    page.selected.set(codOrder);

    const callAction = codOrder.allowed_actions?.find((action) => action.code === 'call_confirm');
    page.openAction(callAction!);

    expect(page.modal()?.kind).toBe('cod_call');
    expect(page.primaryActions().map((action) => action.code)).toEqual(['confirm_cod']);
  });

  it('still opens a pending COD order for a read-only operator', async () => {
    const fixture = await boot(() => of({ rows: [codOrder], count: 1 }), [], {}, { orders: ['read'] });
    const page = fixture.componentInstance;
    const readOnlyCod = { ...codOrder, allowed_actions: [] };

    page.openRow(readOnlyCod);

    expect(page.modal()).toBeNull();
    expect(page.selected()?.order_id).toBe('o2');
  });

  it('saves the call and confirms the COD order in the same step, without a QR scan', async () => {
    const actions: Array<{ action: string; body: Record<string, unknown> }> = [];
    const fixture = await boot(
      () => of({ rows: [codOrder], count: 1 }),
      [],
      {
        performOrderAction: (orderId: string, action: string, body: Record<string, unknown>) => {
          actions.push({ action, body });
          if (action === 'confirm_cod') {
            return of({ order: { ...codOrder, status: 'confirmed', version: 5, allowed_actions: [] }, refund: null });
          }
          return of({ order: { ...codOrder, version: 4 }, refund: null });
        },
      },
    );
    const page = fixture.componentInstance;
    page.selected.set(codOrder);
    page.modal.set({ kind: 'cod_call', order: codOrder });
    page.codCallStarted.set(true);
    page.codDecision.set('confirm');
    page.codNote.set('Khách xác nhận đơn qua điện thoại');

    page.submitCodCall(formEvent({}), true);

    expect(actions.map((entry) => entry.action)).toEqual(['call_confirm', 'confirm_cod']);
    expect(actions[1].body['expectedVersion']).toBe(4);
    expect(String(actions[1].body['note'])).toContain('Khách xác nhận');
    expect(page.modal()).toBeNull();
    expect(page.selected()?.status).toBe('confirmed');
  });

  it('opens confirm_cod as a plain action form and confirms without any scan or photo', async () => {
    const actions: string[] = [];
    const fixture = await boot(
      () => of({ rows: [codOrder], count: 1 }),
      [],
      {
        performOrderAction: (orderId: string, action: string) => {
          actions.push(action);
          return of({ order: { ...codOrder, status: 'confirmed', version: 5, allowed_actions: [] }, refund: null });
        },
      },
    );
    const page = fixture.componentInstance;
    page.selected.set({ ...codOrder, has_successful_call_confirm: true });
    const confirmAction = codOrder.allowed_actions!.find((action) => action.code === 'confirm_cod')!;

    page.openAction(confirmAction);
    expect(page.modal()?.kind).toBe('action');
    expect(page.scanOpen()).toBe(false);

    page.submitAction(formEvent({ note: '' }));
    expect(actions).toEqual(['confirm_cod']);
    expect(page.selected()?.status).toBe('confirmed');
  });

  it('opens the scanner at once for the shipment form and refuses it without a scan or proof photo', async () => {
    const actions: string[] = [];
    const uploads: string[] = [];
    const fixture = await boot(
      () => of({ rows: [shippedOrder], count: 1 }),
      [],
      {
        uploadOrderEvidence: (_id: string, _file: File, stage: string) => {
          uploads.push(stage);
          return of({ evidence_id: 'e-ship', stage, kind: 'image', created_at: '2026-11-08T02:00:00Z' });
        },
        performOrderAction: (orderId: string, action: string) => {
          actions.push(action);
          return of({ order: action === 'upsert_shipment' ? shippedOrder : handedOrder, refund: null });
        },
      },
    );
    const page = fixture.componentInstance;
    page.selected.set(shippedOrder);

    page.openAction(shipmentAction);
    expect(page.scanOpen()).toBe(true);

    page.submitAction(formEvent({ note: 'Xác nhận vận đơn' }));
    expect(page.actionError()).toContain('Quét QR');

    page.applyShipmentScan('GHN123456789');
    page.submitAction(formEvent({ note: 'Xác nhận vận đơn' }));
    expect(page.actionError()).toContain('ảnh minh chứng');
    expect(actions).toEqual([]);
    expect(uploads).toEqual([]);

    page.shipmentPhoto.set(new File(['x'], 'kien-hang.png', { type: 'image/png' }));
    page.submitAction(formEvent({ note: 'Xác nhận vận đơn' }));
    expect(uploads).toEqual(['processing']);
    expect(actions).toEqual(['upsert_shipment', 'confirm_handover']);
  });

  it('shows the carrier label modal after start_processing succeeds', async () => {
    const actions: string[] = [];
    const fixture = await boot(
      () => of({ rows: [codOrder], count: 1 }),
      [],
      {
        performOrderAction: (_orderId: string, action: string) => {
          actions.push(action);
          return of({ order: { ...paidOrder, status: 'processing', version: 3 }, refund: null });
        },
      },
    );
    const page = fixture.componentInstance;
    const startAction = { code: 'start_processing', label: 'Bắt đầu chuẩn bị', to_status: 'processing', requires_note: false, fields: [], destructive: false };
    page.selected.set({ ...paidOrder, status: 'confirmed', allowed_actions: [startAction] });
    page.openAction(startAction);
    page.submitAction(formEvent({ note: '' }));

    expect(actions).toEqual(['start_processing']);
    expect(page.scanOpen()).toBe(false);
    expect(page.modal()?.kind).toBe('carrier_label');
    expect(page.carrierLabel()?.trackingCode).toBe('GHNVL1001');
    expect(page.carrierLabel()?.labelQr).toContain('velura:shipment:1');
    expect(page.scanSample()).toBe(page.carrierLabel()?.labelQr);
  });

  it('label dialog is dismiss-only: closing it never opens the scanner or performs an action', async () => {
    const actions: string[] = [];
    const fixture = await boot(
      () => of({ rows: [paidOrder], count: 1 }),
      [],
      {
        performOrderAction: (_orderId: string, action: string) => {
          actions.push(action);
          return of({ order: paidOrder, refund: null });
        },
      },
    );
    const page = fixture.componentInstance;
    page.selected.set({ ...paidOrder, allowed_actions: [shipmentAction] });
    page.openCarrierLabel(page.selected()!);
    expect(page.modal()?.kind).toBe('carrier_label');
    expect(page.carrierLabel()).not.toBeNull();

    page.closeModal();

    expect(actions).toEqual([]);
    expect(page.scanOpen()).toBe(false);
    expect(page.modal()).toBeNull();
    expect((page as unknown as Record<string, unknown>)['continueToShipment']).toBeUndefined();
  });

  it('printing the label never performs an order action', async () => {
    const actions: string[] = [];
    const fixture = await boot(
      () => of({ rows: [paidOrder], count: 1 }),
      [],
      {
        performOrderAction: (_orderId: string, action: string) => {
          actions.push(action);
          return of({ order: paidOrder, refund: null });
        },
      },
    );
    const page = fixture.componentInstance;
    page.selected.set({ ...paidOrder, allowed_actions: [shipmentAction] });
    page.openCarrierLabel(page.selected()!);
    await page.printOrderLabel(page.selected()!, page.carrierLabel()!);

    expect(actions).toEqual([]);
    expect(page.scanOpen()).toBe(false);
  });

  it('offers the label again from the drawer while processing', async () => {
    const fixture = await boot(() => of({ rows: [paidOrder], count: 1 }));
    const page = fixture.componentInstance;

    page.selected.set({ ...paidOrder, status: 'processing', allowed_actions: [shipmentAction] });
    expect(page.canShowLabel()).toBe(true);
    page.openCarrierLabel(page.selected()!);
    expect(page.carrierLabel()?.order_id).toBe('o1');

    page.selected.set({ ...paidOrder, status: 'confirmed', allowed_actions: [] });
    expect(page.canShowLabel()).toBe(false);
  });

  it('does not auto-open a label for a confirmed exchange order', async () => {
    const exchange: AdminOrderRow = { ...paidOrder, order_id: 'o9', order_kind: 'exchange', status: 'confirmed', allowed_actions: [] };
    const labelCalls: string[] = [];
    const startAction = { code: 'start_processing', label: 'Bắt đầu chuẩn bị', to_status: 'processing', requires_note: false, fields: [], destructive: false };
    const fixture = await boot(
      () => of({ rows: [exchange], count: 1 }),
      [],
      {
        getOrder: () => of({ ...exchange, allowed_actions: [startAction] }),
        getOrderCarrierLabel: (orderId: string) => {
          labelCalls.push(orderId);
          return of({ order_id: orderId, order_code: 'VL-1001', carrier: 'GHN', trackingCode: 'GHNVL1001', trackingUrl: '', labelQr: 'velura:shipment:1?order=VL-1001' });
        },
        performOrderAction: () => of({ order: { ...exchange, status: 'processing', version: 4 }, refund: null }),
      },
    );
    const page = fixture.componentInstance;

    page.openDetail('o9');
    expect(page.modal()).toBeNull();
    expect(labelCalls).toEqual([]);
    expect(page.canShowLabel()).toBe(false);

    page.openAction(startAction);
    page.submitAction(formEvent({ note: '' }));
    expect(page.modal()?.kind).toBe('carrier_label');
    expect(labelCalls).toEqual(['o9']);
  });

  it('shows the source return of an exchange order', async () => {
    const exchange: AdminOrderRow = {
      ...paidOrder,
      order_id: 'o9',
      order_kind: 'exchange',
      status: 'confirmed',
      allowed_actions: [],
      parent_order_id: 'o1',
      source_return_id: 'r1',
      source_return: { return_id: 'r1', return_code: 'RT-1' },
    };
    const fixture = await boot(
      () => of({ rows: [exchange], count: 1 }),
      [],
      { getOrder: () => of(exchange) },
      { orders: ['read', 'update'], returns: ['read'] },
    );
    const page = fixture.componentInstance;
    page.openDetail('o9');
    fixture.detectChanges();

    expect(page.sourceReturnLinks()).toEqual([
      { label: 'Mở phiếu đổi trả', commands: ['/returns'], query: { focus: 'r1' } },
      { label: 'Đơn hàng gốc', commands: ['/orders'], query: { focus: 'o1' } },
    ]);
    expect(document.body.textContent).toContain('Phiếu đổi trả gốc');
    expect(document.body.textContent).toContain('RT-1');
  });

  it('says so when the shipment stored but the handover did not', async () => {
    const fixture = await boot(
      () => of({ rows: [shippedOrder], count: 1 }),
      [],
      {
        performOrderAction: (orderId: string, action: string) => {
          if (action === 'upsert_shipment') return of({ order: shippedOrder, refund: null });
          return throwError(() => new Error('Đơn đã bị vô hiệu vận đơn.'));
        },
      },
    );
    const page = fixture.componentInstance;

    page.selected.set(shippedOrder);
    page.applyShipmentScan('GHN123456789');
    page.shipmentPhoto.set(new File(['x'], 'kien-hang.png', { type: 'image/png' }));
    page.modal.set({ kind: 'action', action: shipmentAction });
    page.submitAction(formEvent({ note: 'Xác nhận vận đơn GHN123456789' }));

    expect(page.notice()).toContain('Vận đơn đã lưu');
    expect(page.notice()).toContain('bàn giao chưa thành công');
    expect(page.submitting()).toBe(false);
  });

  it('folds the return records of the open order into the same trail', async () => {
    const fixture = await boot(
      () => of({ rows: [paidOrder], count: 1 }),
      [],
      {
        getOrder: () =>
          of({
            ...paidOrder,
            events: [{ event_id: 'e1', action: 'confirm_handover', created_at: '2026-10-21T02:00:00Z', actor_type: 'manual' }],
          }),
        listReturns: () =>
          of({ rows: [{ return_id: 'r-1', order_id: 'o1', status: 'RECEIVED', created_at: '2026-10-23T02:00:00Z' }], count: 1 }),
      },
      { orders: ['read', 'update'], returns: ['read'] },
    );
    const page = fixture.componentInstance;
    page.openDetail('o1');

    const titles = page.trace().map((entry) => entry.title);
    expect(titles[0]).toContain('Đổi trả r-1');
    expect(titles).toContain('Bàn giao đơn vị vận chuyển');
    expect(page.trace()[0].links.length).toBe(1);
    expect(page.orderLinks().map((link) => link.label)).toContain('Đổi trả của đơn này');
  });

  it('never asks for returns the operator has no right to read', async () => {
    let called = 0;
    const fixture = await boot(() => of({ rows: [paidOrder], count: 1 }), [], {
      listReturns: () => {
        called += 1;
        return of({ rows: [], count: 0 });
      },
    });
    const page = fixture.componentInstance;
    page.openDetail('o1');

    expect(page.canReadReturns()).toBe(false);
    expect(called).toBe(0);
    expect(page.trace().length).toBe(0);
  });

  it('filters facts and evidence by stage and uploads evidence for that stage', async () => {
    const uploads: Array<{ stage: string; note: string }> = [];
    const fixture = await boot(() => of({ rows: [codOrder], count: 1 }), [], {
      uploadOrderEvidence: (_id: string, _file: File, stage: string, note: string) => {
        uploads.push({ stage, note });
        return of({ evidence_id: 'e-1', stage, kind: 'image', url: 'https://signed', created_at: '2026-10-23T02:00:00Z' });
      },
    });
    const page = fixture.componentInstance;
    page.selected.set({
      ...codOrder,
      events: [
        { event_id: 'e-prep', action: 'upsert_shipment', from_status: 'confirmed', to_status: 'processing', created_at: '2026-10-23T02:00:00Z' },
        { event_id: 'e-ship', action: 'confirm_handover', from_status: 'processing', to_status: 'shipping', created_at: '2026-10-23T03:00:00Z' },
      ],
      evidence: [{ evidence_id: 'old', stage: 'processing', kind: 'image', url: 'https://old', created_at: '2026-10-23T01:00:00Z' }],
    });

    page.selectStage('processing');
    expect(page.stageEntries().every((entry) => entry.stage === 'processing')).toBe(true);
    expect(page.stageEvidence().map((item) => item.evidence_id)).toEqual(['old']);

    page.evidenceFile.set(new File(['proof'], 'proof.png', { type: 'image/png' }));
    page.evidenceNote.set('Ảnh đóng gói');
    page.submitEvidence({ preventDefault: () => undefined, target: document.createElement('form') } as unknown as Event);

    expect(uploads).toEqual([{ stage: 'processing', note: 'Ảnh đóng gói' }]);
    expect(page.selected()?.evidence?.[0].evidence_id).toBe('e-1');
  });
});
