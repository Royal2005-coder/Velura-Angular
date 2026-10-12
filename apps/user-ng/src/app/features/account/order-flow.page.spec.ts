import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import {
  DEMO_LINES,
  DemoOrder,
  DemoReturn,
  PurchaseDemoStore,
} from '../../core/services/purchase-demo.store';
import { ORDER_ACCOUNT_MODEL } from '../../core/services/order-account.model';
import { stubActivatedRoute } from '../../../testing/storefront-testing';
import { OrderFlowPage } from './order-flow.page';

const order: DemoOrder = {
  id: 'DEMO-TEST',
  member: false,
  address: {
    name: 'Khách',
    phone: '0901234567',
    email: '',
    province: 'Mẫu',
    district: 'Mẫu',
    ward: 'Mẫu',
    detail: 'Mẫu',
  },
  items: DEMO_LINES.map((line) => ({ ...line, returnCount: 0, availableQuantity: 1 })),
  status: 'preparing',
  payment: 'COD',
  paymentState: 'pending',
  subtotal: 840000,
  shipping: 0,
  discount: 84000,
  total: 756000,
  voucher: 'DEMO10',
  createdAt: '2026-09-24T00:00:00Z',
};
const pendingRequest: DemoReturn = {
  id: 'RET-TEST',
  orderId: order.id,
  kind: 'refund',
  items: [{ variantId: DEMO_LINES[0].variant_id, quantity: 1 }],
  reason: '',
  evidenceNames: [],
  stage: 0,
  createdAt: '2026-09-25T00:00:00Z',
};
describe('OrderFlowPage with mocked Model', () => {
  const model = {
    member: signal(false),
    userId: signal<string | null>(null),
    canAccess: (row: DemoOrder) => !row.member && row.address.phone === '0901234567',
    orders: signal([order]),
    requests: signal<DemoReturn[]>([]),
    verifiedPhone: signal('0901234567'),
    loading: signal(false),
    error: signal<string | null>(null),
    cancellableBeforeStage: 3,
    supportsBankInfo: true,
    timeline: () => [
      'Đã ghi nhận',
      'Velura đang liên hệ',
      'Chờ gửi hàng',
      'Hàng đang về Velura',
      'Velura đã nhận hàng',
      'Đang hoàn tiền',
      'Đã hoàn tiền',
    ],
    cancelRequest: vi.fn(),
  };
  beforeEach(async () => {
    model.member.set(false);
    model.verifiedPhone.set('');
    model.requests.set([]);
    model.loading.set(false);
    model.error.set(null);
    model.cancelRequest.mockReset();
    model.cancelRequest.mockResolvedValue(undefined);
    await TestBed.configureTestingModule({
      imports: [OrderFlowPage],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: stubActivatedRoute({ id: order.id }) },
        { provide: ORDER_ACCOUNT_MODEL, useValue: model },
      ],
    }).compileComponents();
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });
  afterEach(() => TestBed.resetTestingModule());
  it('does not expose guest order details from a direct link before OTP', () => {
    const fixture = TestBed.createComponent(OrderFlowPage);
    fixture.detectChanges();
    expect(fixture.componentInstance.view()).toBe('lookup');
    expect(fixture.componentInstance.order()).toBeNull();
    expect(fixture.componentInstance.visibleOrders()).toEqual([]);
    expect(fixture.nativeElement.textContent).not.toContain('756.000');
  });
  it('shows an empty order result only after a successful completed load', () => {
    const fixture = TestBed.createComponent(OrderFlowPage);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    page.view.set('list');
    model.loading.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Chưa có đơn hàng phù hợp');
    model.loading.set(false);
    model.error.set('Không tải được danh sách đơn hàng.');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Không tải được danh sách đơn hàng.');
    expect(fixture.nativeElement.textContent).not.toContain('Chưa có đơn hàng phù hợp');
    expect(fixture.nativeElement.querySelector('input')?.placeholder).not.toContain('DEMO');
    model.error.set(null);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Chưa có đơn hàng phù hợp');
  });
  it('does not claim there are no returns when their list failed', () => {
    const fixture = TestBed.createComponent(OrderFlowPage);
    fixture.detectChanges();
    fixture.componentInstance.view.set('requests');
    model.error.set('Không tải được yêu cầu đổi trả.');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Chưa có yêu cầu đổi / trả.');
  });
  it('keeps an OTP-verified guest authorized across canonical order routes', () => {
    model.verifiedPhone.set('0901234567');
    const fixture = TestBed.createComponent(OrderFlowPage);
    fixture.detectChanges();
    expect(fixture.componentInstance.verified()).toBe(true);
    expect(fixture.componentInstance.view()).toBe('detail');
    expect(fixture.componentInstance.order()?.id).toBe(order.id);
  });
  it('hides cancellation as soon as the authorized order enters preparation', () => {
    const fixture = TestBed.createComponent(OrderFlowPage);
    const page = fixture.componentInstance;
    page.verified.set(true);
    page.open(order.id);
    fixture.detectChanges();
    expect(page.view()).toBe('detail');
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );
    expect(buttons.some((button) => button.textContent?.trim() === 'Hủy đơn')).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('không thể hủy tại thời điểm này');
  });
  it('lets the customer cancel a return request before it has shipped back', () => {
    model.requests.set([pendingRequest]);
    const fixture = TestBed.createComponent(OrderFlowPage);
    const page = fixture.componentInstance;
    page.verified.set(true);
    page.open(order.id);
    page.track(pendingRequest);
    fixture.detectChanges();
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );
    const cancelButton = buttons.find((button) => button.textContent?.trim() === 'Hủy yêu cầu');
    expect(cancelButton).toBeTruthy();
    cancelButton?.click();
    expect(model.cancelRequest).toHaveBeenCalledWith(pendingRequest.id);
  });
  it('hides the self-service cancel once the request has shipped back to Velura', () => {
    model.requests.set([{ ...pendingRequest, stage: 3 }]);
    const fixture = TestBed.createComponent(OrderFlowPage);
    const page = fixture.componentInstance;
    page.verified.set(true);
    page.open(order.id);
    page.track({ ...pendingRequest, stage: 3 });
    fixture.detectChanges();
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );
    expect(buttons.some((button) => button.textContent?.trim() === 'Hủy yêu cầu')).toBe(false);
  });

  it('blocks starting a new return on a single-item order when a return is already in progress (TC-RMA-09)', () => {
    const deliveredSingle: DemoOrder = {
      ...order,
      id: 'VLR-SINGLE-1',
      status: 'delivered',
      can_request_return: true,
      items: [
        {
          ...DEMO_LINES[0],
          quantity: 1,
          returnCount: 1,
          availableQuantity: 0,
          isInProgress: true,
          inProgressCode: 'RET4BD544C8',
          inProgressStatus: 'CONTACTING',
        },
      ],
    };
    model.orders.set([deliveredSingle]);
    model.requests.set([{ ...pendingRequest, id: 'RET4BD544C8', orderId: 'VLR-SINGLE-1', status: 'CONTACTING' }]);
    const fixture = TestBed.createComponent(OrderFlowPage);
    const page = fixture.componentInstance;
    page.verified.set(true);
    page.open('VLR-SINGLE-1');
    fixture.detectChanges();

    expect(page.canStartReturn(deliveredSingle)).toBe(false);
    expect(page.orderReturnStatusBadge(deliveredSingle)?.kind).toBe('in_progress');
    expect(page.returnBlockedReason(deliveredSingle)).toContain('RET4BD544C8');
  });

  it('allows return for remaining eligible items on a multi-item order while locking in-progress items (TC-RMA-09)', () => {
    const deliveredMulti: DemoOrder = {
      ...order,
      id: 'VLR-MULTI-1',
      status: 'delivered',
      can_request_return: true,
      items: [
        {
          ...DEMO_LINES[0],
          variant_id: 'v-locked',
          product_name: 'Áo Đang Đổi Trả',
          quantity: 1,
          returnCount: 1,
          availableQuantity: 0,
          isInProgress: true,
          inProgressCode: 'RET111',
          inProgressStatus: 'REQUESTED',
        },
        {
          ...DEMO_LINES[0],
          variant_id: 'v-eligible',
          product_name: 'Quần Chưa Đổi Trả',
          quantity: 2,
          returnCount: 0,
          availableQuantity: 2,
          isInProgress: false,
        },
      ],
    };
    model.orders.set([deliveredMulti]);
    const fixture = TestBed.createComponent(OrderFlowPage);
    const page = fixture.componentInstance;
    page.verified.set(true);
    page.open('VLR-MULTI-1');
    fixture.detectChanges();

    expect(page.canStartReturn(deliveredMulti)).toBe(true);
    page.startReturn();
    expect(page.view()).toBe('return');

    // Không cho chọn sản phẩm đang xử lý đổi trả
    page.select(deliveredMulti.items[0], true);
    expect(page.selections()['v-locked']).toBeUndefined();

    // Cho phép chọn sản phẩm còn lại và giới hạn số lượng theo số đã mua
    page.select(deliveredMulti.items[1], true);
    expect(page.selections()['v-eligible']?.quantity).toBe(1);
    page.stepQuantity(deliveredMulti.items[1], 1);
    expect(page.selections()['v-eligible']?.quantity).toBe(2);
    page.stepQuantity(deliveredMulti.items[1], 5);
    expect(page.selections()['v-eligible']?.quantity).toBe(2);
  });
});
