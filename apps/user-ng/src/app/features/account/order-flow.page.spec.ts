import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import {
  DEMO_LINES,
  DemoOrder,
  DemoReturn,
  PurchaseDemoStore,
} from '../../core/services/purchase-demo.store';
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
    model.cancelRequest.mockReset();
    await TestBed.configureTestingModule({
      imports: [OrderFlowPage],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: stubActivatedRoute({ id: order.id }) },
        { provide: PurchaseDemoStore, useValue: model },
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
});
