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
  let routeOrderId: string | null = order.id;
  const model = {
    member: signal(false),
    userId: signal<string | null>(null),
    canAccess: (row: DemoOrder) => !row.member && row.address.phone === '0901234567',
    orders: signal([order]),
    requests: signal<DemoReturn[]>([]),
    verifiedPhone: signal('0901234567'),
    otpExpiresIn: signal(60),
    loading: signal(false),
    error: signal<string | null>(null),
    cancellableBeforeStage: 3,
    supportsBankInfo: true,
    sendOtp: vi.fn(),
    verifyOtp: vi.fn(),
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
    saveBank: vi.fn(),
  };
  beforeEach(async () => {
    routeOrderId = order.id;
    model.member.set(false);
    model.verifiedPhone.set('');
    model.requests.set([]);
    model.loading.set(false);
    model.error.set(null);
    model.cancelRequest.mockReset();
    model.cancelRequest.mockResolvedValue(undefined);
    model.saveBank.mockReset();
    model.saveBank.mockResolvedValue(undefined);
    model.orders.set([order]);
    model.sendOtp.mockReset();
    model.sendOtp.mockResolvedValue(undefined);
    model.verifyOtp.mockReset();
    model.verifyOtp.mockResolvedValue(undefined);
    await TestBed.configureTestingModule({
      imports: [OrderFlowPage],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            ...stubActivatedRoute(),
            snapshot: {
              ...stubActivatedRoute().snapshot,
              paramMap: { get: (name: string) => name === 'id' ? routeOrderId : null },
            },
          },
        },
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
  it('starts the guest orders entry at both lookup choices even with a previous OTP session', () => {
    routeOrderId = null;
    model.verifiedPhone.set('0901234567');
    const fixture = TestBed.createComponent(OrderFlowPage);
    fixture.detectChanges();

    expect(fixture.componentInstance.view()).toBe('lookup');
    expect(fixture.componentInstance.verified()).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('Bằng SĐT');
    expect(fixture.nativeElement.textContent).toContain('Bằng mã đơn');
  });
  it('shows a one-minute OTP countdown as minutes and seconds', () => {
    const fixture = TestBed.createComponent(OrderFlowPage);
    const page = fixture.componentInstance;
    page.view.set('otp');
    page.seconds.set(60);
    fixture.detectChanges();

    expect(page.countdown()).toBe('01:00');
    expect(fixture.nativeElement.textContent).toContain('Hiệu lực 01:00');
    page.seconds.set(9);
    expect(page.countdown()).toBe('00:09');
  });
  it('blocks OTP verification after five invalid attempts', async () => {
    model.verifyOtp.mockRejectedValue(Object.assign(new Error('Mã xác thực không hợp lệ.'), { code: 'INVALID_OTP' }));
    const fixture = TestBed.createComponent(OrderFlowPage);
    const page = fixture.componentInstance;
    page.view.set('otp');
    page.seconds.set(60);
    page.otp = '000000';

    for (let attempt = 0; attempt < 5; attempt++) {
      page.verify();
      await fixture.whenStable();
    }
    fixture.detectChanges();

    expect(page.failedOtpAttempts()).toBe(5);
    expect(fixture.nativeElement.textContent).toContain('nhập sai OTP 5 lần');
    page.verify();
    expect(model.verifyOtp).toHaveBeenCalledTimes(5);
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

  function openTracking(request: DemoReturn, target: DemoOrder = order) {
    model.orders.set([target]);
    model.requests.set([request]);
    const fixture = TestBed.createComponent(OrderFlowPage);
    const page = fixture.componentInstance;
    page.verified.set(true);
    page.open(target.id);
    page.track(request);
    fixture.detectChanges();
    const text = () => (fixture.nativeElement.textContent as string).replace(/\s+/g, ' ');
    return { fixture, page, text };
  }
  const rejectedRequest: DemoReturn = {
    ...pendingRequest,
    status: 'CANCELLED',
    stage: -1,
    cancelledBy: 'admin',
    rejectedAt: '2026-10-18T09:00:00Z',
    rejectionReason: 'Sản phẩm đã qua sử dụng',
  };
  const customerCancelledRequest: DemoReturn = {
    ...pendingRequest,
    status: 'CANCELLED',
    stage: -1,
    cancelledBy: 'customer',
    cancelledAt: '2026-10-18T09:00:00Z',
  };
  const codRefundRequest: DemoReturn = { ...pendingRequest, status: 'CONTACTING', stage: 1, paymentMethod: 'COD', refundFlow: 'cod_manual' };
  const deliveredWithRelease = (): DemoOrder => ({
    ...order,
    id: 'VLR-REJ-1',
    status: 'delivered',
    can_request_return: true,
    items: [{ ...DEMO_LINES[0], quantity: 1, returnCount: 0, availableQuantity: 1, isInProgress: false }],
  });

  it('shows "Bị từ chối" with the reason when CSKH refused the request, instead of "Đã hủy yêu cầu"', () => {
    const { page, text } = openTracking(rejectedRequest);
    expect(page.requestLabel(rejectedRequest)).toBe('Bị từ chối');
    expect(text()).toContain('Bị từ chối');
    expect(text()).toContain('Yêu cầu bị từ chối lúc');
    expect(text()).toContain('Sản phẩm đã qua sử dụng');
    expect(text()).toContain('Lượt đổi/trả của sản phẩm đã được hoàn lại, bạn có thể gửi yêu cầu mới.');
    expect(text()).not.toContain('Đã hủy yêu cầu');
  });

  it('keeps "Đã hủy yêu cầu" for a request the customer cancelled themself', () => {
    const { page, text } = openTracking(customerCancelledRequest);
    expect(page.requestLabel(customerCancelledRequest)).toBe('Đã hủy yêu cầu');
    expect(text()).toContain('Đã hủy yêu cầu lúc');
    expect(text()).toContain('Lượt đổi/trả của sản phẩm đã được hoàn lại, bạn có thể gửi yêu cầu mới.');
    expect(text()).not.toContain('Bị từ chối');
    expect(text()).not.toContain('Yêu cầu bị từ chối');
  });

  it('hides refund and bank blocks for a rejected COD refund request', () => {
    const request: DemoReturn = { ...rejectedRequest, paymentMethod: 'COD', refundReceiver: { status: 'supplement_requested', supplementRequest: 'Gửi lại số tài khoản' } };
    const { fixture, text } = openTracking(request);
    expect(text()).not.toContain('Gửi lại số tài khoản');
    expect(text()).not.toContain('Lưu thông tin nhận tiền');
    expect(fixture.nativeElement.querySelector('input[name="account"]')).toBeNull();
  });

  it('lists a refused request as "Bị từ chối" and a self-cancelled one as "Đã hủy yêu cầu"', () => {
    model.orders.set([order]);
    model.requests.set([rejectedRequest, { ...customerCancelledRequest, id: 'RET-SELF' }]);
    const fixture = TestBed.createComponent(OrderFlowPage);
    const page = fixture.componentInstance;
    page.verified.set(true);
    page.view.set('requests');
    fixture.detectChanges();
    const pills = Array.from(fixture.nativeElement.querySelectorAll('.return-status-pill') as NodeListOf<HTMLElement>).map((pill) => pill.textContent?.trim());
    expect(pills).toEqual(['Bị từ chối', 'Đã hủy yêu cầu']);
  });

  it('treats a rejected request as released: it neither blocks a new request nor counts as success', () => {
    const delivered = deliveredWithRelease();
    model.orders.set([delivered]);
    model.requests.set([{ ...rejectedRequest, id: 'RET-REJ', orderId: delivered.id }]);
    const page = TestBed.createComponent(OrderFlowPage).componentInstance;
    expect(page.orderActiveReturn(delivered)).toBeNull();
    expect(page.canStartReturn(delivered)).toBe(true);
    expect(page.returnBlockedReason(delivered)).toBeNull();
    expect(page.orderReturnStatusBadge(delivered)).toEqual({ kind: 'rejected', label: 'Yêu cầu đổi/trả bị từ chối', code: 'RET-REJ' });
  });

  it('shows no return badge for a self-cancelled request and still allows a new one', () => {
    const delivered = deliveredWithRelease();
    model.orders.set([delivered]);
    model.requests.set([{ ...customerCancelledRequest, orderId: delivered.id }]);
    const page = TestBed.createComponent(OrderFlowPage).componentInstance;
    expect(page.canStartReturn(delivered)).toBe(true);
    expect(page.orderReturnStatusBadge(delivered)).toBeNull();
  });

  it('displays the CSKH supplement request and the bank form for a COD refund waiting on receiving info', () => {
    const request: DemoReturn = { ...codRefundRequest, refundReceiver: { status: 'supplement_requested', supplementRequest: 'Vui lòng gửi lại số tài khoản đúng định dạng' } };
    const { fixture, text } = openTracking(request);
    expect(text()).toContain('CSKH yêu cầu bổ sung thông tin nhận hoàn tiền: Vui lòng gửi lại số tài khoản đúng định dạng');
    expect(fixture.nativeElement.querySelector('input[name="account"]')).not.toBeNull();
    expect(text()).toContain('Lưu thông tin nhận tiền');
  });

  it('shows the bank form for a COD refund whose receiving info is missing or invalid', () => {
    for (const status of ['missing', 'invalid'] as const) {
      const { fixture, text } = openTracking({ ...codRefundRequest, refundReceiver: { status } });
      expect(fixture.nativeElement.querySelector('input[name="account"]')).not.toBeNull();
      if (status === 'invalid') expect(text()).toContain('chưa hợp lệ');
      fixture.destroy();
    }
  });

  it('does not ask for receiving info before CSKH has made contact', () => {
    const { fixture } = openTracking({ ...codRefundRequest, status: 'REQUESTED', stage: 0, refundReceiver: { status: 'missing' } });
    expect(fixture.nativeElement.querySelector('input[name="account"]')).toBeNull();
  });

  it('submits the receiving info through the Model and closes the update form', async () => {
    const { page } = openTracking({ ...codRefundRequest, refundReceiver: { status: 'missing' } });
    page.bankName = 'Vietcombank';
    page.bankAccount = '0123456789';
    page.bankHolder = 'Nguyen Van A';
    page.saveBank();
    await vi.waitFor(() => expect(page.bankAccount).toBe(''));
    expect(model.saveBank).toHaveBeenCalledWith(pendingRequest.id, 'Vietcombank', '0123456789', 'Nguyen Van A');
    expect(page.error()).toBe('');
  });

  it('echoes a valid receiving account with a "Cập nhật" action until the refund is paid', () => {
    const request: DemoReturn = { ...codRefundRequest, refundReceiver: { status: 'valid', bankName: 'Vietcombank', accountLast4: '7890', holder: 'NGUYEN VAN A' } };
    const { fixture, page, text } = openTracking(request);
    expect(text()).toContain('Tài khoản nhận tiền: Vietcombank · ••••7890 (NGUYEN VAN A)');
    expect(fixture.nativeElement.querySelector('input[name="account"]')).toBeNull();
    const update = (Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)).find((button) => button.textContent?.trim() === 'Cập nhật');
    expect(update).toBeTruthy();
    update?.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('input[name="account"]')).not.toBeNull();
    expect(page.bankName).toBe('Vietcombank');
    expect(page.bankAccount).toBe('');
  });

  it('offers no "Cập nhật" once the refund has been transferred', () => {
    const request: DemoReturn = { ...codRefundRequest, status: 'REFUNDED', stage: 6, completedAt: '2026-10-19T09:00:00Z', refundReceiver: { status: 'valid', bankName: 'Vietcombank', accountLast4: '7890', holder: 'NGUYEN VAN A' } };
    const { fixture, text } = openTracking(request);
    expect(text()).toContain('Tiền đã được chuyển tới: Vietcombank · ••••7890');
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>);
    expect(buttons.some((button) => button.textContent?.trim() === 'Cập nhật')).toBe(false);
  });

  it('never shows the bank form or supplement notice for an online (Stripe) refund', () => {
    const stripeOrder: DemoOrder = { ...order, id: 'DEMO-STRIPE', payment: 'STRIPE' };
    const request: DemoReturn = { ...pendingRequest, orderId: stripeOrder.id, status: 'CONTACTING', stage: 1, paymentMethod: 'ONLINE_PAYMENT', refundFlow: 'stripe_auto', refundReceiver: undefined };
    const { fixture, text } = openTracking(request, stripeOrder);
    expect(fixture.nativeElement.querySelector('input[name="account"]')).toBeNull();
    expect(text()).not.toContain('CSKH yêu cầu bổ sung');
    expect(text()).not.toContain('Lưu thông tin nhận tiền');
  });
});
