import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { CheckoutStore } from '../../core/services/checkout.store';
import { AuthService } from '../../core/services/auth.service';
import { DEMO_LINES, DemoAddress, type DemoOrder } from '../../core/services/purchase-demo.store';
import { stubActivatedRoute, stubAddressGeographyService } from '../../../testing/storefront-testing';
import { AddressGeographyService } from '../../core/services/address-geography.service';
import { PurchaseCustomerStore } from '../../core/services/purchase-customer.store';
import { VoucherService } from '../../core/services/voucher.service';
import { PurchaseFlowPage } from './purchase-flow.page';
import { PurchaseFlowApiService } from '../../core/services/purchase-flow-api.service';
import { OrderAccountApiStore } from '../../core/services/order-account-api.store';
import { CheckoutLineEditorService } from '../../core/services/checkout-line-editor.service';
import { of, Subject } from 'rxjs';

function createCheckoutFixture() {
  const fixture = TestBed.createComponent(PurchaseFlowPage);
  fixture.componentInstance.addressGeographyValid.set(true);
  fixture.componentInstance.draftGeographyValid.set(true);
  fixture.componentInstance.refreshQuote();
  return fixture;
}

describe('PurchaseFlowPage with mocked Model', () => {
  const place = vi.fn();
  const checkoutGuest = vi.fn();
  const checkoutMember = vi.fn();
  const sendOtp = vi.fn();
  const verifyOtp = vi.fn();
  const quote = vi.fn();
  const loadPaymentOrder = vi.fn();
  const model = {
    member: signal(false),
    userId: signal<string | null>(null),
    ownsOrder: () => false,
    canAccess: () => false,
    addresses: signal<DemoAddress[]>([]),
    orders: signal([]),
    loading: signal(false),
    error: signal(''),
    verifiedPhone: signal('0901234567'),
    quote: () => ({
      subtotal: 840000,
      shipping: 0,
      discount: 84000,
      total: 756000,
      voucher: 'DEMO10',
    }),
    sendOtp: vi.fn(),
    verifyOtp: vi.fn(),
    saveAddress: vi.fn(() => 0),
    place,
  };
  beforeEach(async () => {
    vi.useFakeTimers();
    place.mockReset();
    checkoutGuest.mockReset();
    checkoutMember.mockReset();
    sendOtp.mockReset();
    verifyOtp.mockReset();
    sendOtp.mockReturnValue(of({ success: true }));
    verifyOtp.mockReturnValue(of({ success: true, guest_checkout_token: 'signed-proof' }));
    quote.mockReset();
    loadPaymentOrder.mockReset();
    quote.mockReturnValue(of({ subtotal: 840000, shipping_fee: 0, discount_amount: 50000, total_amount: 790000, voucher: { voucher_id: 'admin-voucher', code: 'REAL50', name: 'Ưu đãi', discount_amount: 50000 }, voucher_change: null, free_shipping_threshold: 500000, free_shipping_shortfall: 0 }));
    checkoutGuest.mockReturnValue(of({ success: true, order: { order_id: 'order-1', order_code: 'VLR-1' } }));
    checkoutMember.mockReturnValue(of({ success: true, order: { order_id: 'order-1', order_code: 'VLR-1' } }));
    model.member.set(false);
    model.userId.set(null);
    model.addresses.set([]);
    model.saveAddress.mockClear();
    await TestBed.configureTestingModule({
      imports: [PurchaseFlowPage],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: stubActivatedRoute() },
        {
          provide: CheckoutStore,
          useValue: {
            source: () => 'cart',
            shipping: () => ({ referral_code: '' }),
            readCheckoutItems: () => DEMO_LINES,
            readCreatedOrder: () => null,
            saveCreatedOrder: vi.fn(),
            completeCheckout: vi.fn(),
          },
        },
        { provide: AuthService, useValue: { session: () => null } },
        { provide: CheckoutLineEditorService, useValue: { choices: () => of([]), edit: vi.fn(), remove: vi.fn() } },
        { provide: PurchaseCustomerStore, useValue: model },
        { provide: OrderAccountApiStore, useValue: { canAccess: () => false, guestAccessToken: () => null, loadPaymentOrder } },
        { provide: AddressGeographyService, useValue: stubAddressGeographyService() },
        { provide: VoucherService, useValue: { quote, loadWallet: () => of({ vouchers: [], best_voucher_id: null }) } },
        {
          provide: PurchaseFlowApiService,
          useValue: {
            providers: () => of({ providers: [{ code: 'COD', enabled: true }, { code: 'STRIPE', enabled: true }] }),
            sendOtp,
            verifyOtp,
            checkoutGuest,
            checkoutMember,
            confirmPayment: vi.fn(() => of({ success: true })),
            switchToCod: vi.fn(() => of({ success: true })),
          },
        },
      ],
    }).compileComponents();
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });
  it('renders the delivery form and inline OTP for guests', () => {
    const fixture = createCheckoutFixture();
    fixture.detectChanges();
    expect(fixture.componentInstance.step()).toBe('form');
    expect(fixture.nativeElement.textContent).toContain('Họ tên người nhận');
    expect(fixture.nativeElement.textContent).toContain('Gửi mã OTP');
    expect(fixture.nativeElement.querySelector('[aria-label="Mở sổ địa chỉ"]')).toBeNull();
  });
  it('never displays success on a failed create and ignores duplicate clicks', () => {
    const request = new Subject<never>();
    checkoutMember.mockReturnValue(request);
    const fixture = createCheckoutFixture();
    const page = fixture.componentInstance;
    model.member.set(true);
    page.address = {
      name: 'Nguyễn An',
      phone: '0912345678',
      email: '',
      province: 'Mẫu',
      district: 'Mẫu',
      ward: 'Mẫu',
      detail: 'Mẫu',
    };
    page.place();
    page.place();
    expect(checkoutMember).toHaveBeenCalledTimes(1);
    request.error(new Error('Tạo đơn lỗi'));
    expect(page.step()).toBe('form');
    expect(page.error()).toBe('Tạo đơn lỗi');
    expect(page.order()).toBeNull();
    expect(page.busy()).toBe(false);
  });
  it('requires OTP for guests but allows a member to continue without it', () => {
    const page = createCheckoutFixture().componentInstance;
    page.address = {
      name: 'Nguyễn An',
      phone: '0912345678',
      email: '',
      province: 'Mẫu',
      district: 'Mẫu',
      ward: 'Mẫu',
      detail: 'Mẫu',
    };
    expect(page.validateCheckout()).toBe(false);
    expect(page.otpError()).toContain('xác thực SĐT');

    model.member.set(true);
    page.address = {
      name: 'Nguyễn An',
      phone: '0912345678',
      email: '',
      province: 'Mẫu',
      district: 'Mẫu',
      ward: 'Mẫu',
      detail: 'Mẫu',
    };
    expect(page.validateCheckout()).toBe(true);
  });
  it('accepts the inline OTP state for the same Guest phone', () => {
    const page = createCheckoutFixture().componentInstance;
    page.address = {
      name: 'Nguyễn An',
      phone: '0912345678',
      email: 'guest@example.com',
      province: 'Mẫu',
      district: 'Mẫu',
      ward: 'Mẫu',
      detail: 'Mẫu',
    };
    page.otpPhone.set('0912345678');
    page.otpVerified.set(true);

    expect(page.validateCheckout()).toBe(true);
    expect(page.otpError()).toBe('');
  });
  it('does not mark the phone verified when backend rejects the OTP', () => {
    const request = new Subject<{ success?: boolean; message?: string }>();
    verifyOtp.mockReturnValueOnce(request);
    const page = createCheckoutFixture().componentInstance;
    page.address.phone = '0855808330';
    page.otpPhone.set('0855808330');
    page.digits.set(['0', '0', '0', '0', '0', '0']);
    page.verify();
    request.error(new Error('Mã OTP không hợp lệ. Bạn còn 3 lần thử.'));

    expect(page.otpVerified()).toBe(false);
    expect(page.otpError()).toContain('không hợp lệ');
  });
  it('shows the User address book instead of OTP and prefills the current account default', () => {
    model.member.set(true);
    model.userId.set('a');
    model.addresses.set([{ name: 'A', phone: '0901234567', email: '', province: 'HCM', district: 'Q1', ward: 'P1', detail: 'Địa chỉ A', isDefault: true }]);
    const fixture = createCheckoutFixture();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Gửi mã OTP');
    expect(fixture.nativeElement.querySelector('[aria-label="Mở sổ địa chỉ"]')).not.toBeNull();
    expect(fixture.componentInstance.address.detail).toBe('Địa chỉ A');
  });
  it('invalidates Guest OTP when the delivery phone changes', () => {
    const page = createCheckoutFixture().componentInstance;
    page.otpPhone.set('0901234567');
    page.otpVerified.set(true);
    page.editField('phone', '0912345678');
    expect(page.otpVerified()).toBe(false);
    expect(page.otpPhone()).toBe('');
  });
  it('uses a User address for this order without saving when the option is off', () => {
    model.member.set(true);
    const page = createCheckoutFixture().componentInstance;
    vi.spyOn(page, 'closeAddressBook').mockImplementation(() => {});
    page.addressDraft = { name: 'Nguyễn An', phone: '0901234567', email: '', province: 'HCM', district: 'Q1', ward: 'P1', detail: 'Địa chỉ mới' };
    page.saveDraft = false;
    page.useDraftAddress();
    expect(page.address.detail).toBe('Địa chỉ mới');
    expect(model.saveAddress).not.toHaveBeenCalled();
  });

  it('resumes a cold unpaid order with its real UUID and blocks creating another order', async () => {
    const address = { name: 'Nguyen An', phone: '0912345678', email: '', province: 'HCM', district: '', ward: 'Ward', detail: '12 Street' };
    const order: DemoOrder = { id: 'VLR-OLD', orderId: 'order-uuid', member: true, userId: 'a', address, items: DEMO_LINES.map((line) => ({ ...line, returnCount: 0, availableQuantity: line.quantity })), status: 'pending_payment', payment: 'VNPAY', paymentState: 'pending', subtotal: 840000, shipping: 0, discount: 50000, total: 790000, voucher: 'REAL50', createdAt: new Date().toISOString() };
    loadPaymentOrder.mockResolvedValue(order);
    const route = stubActivatedRoute();
    TestBed.overrideProvider(ActivatedRoute, { useValue: { ...route, snapshot: { ...route.snapshot, queryParamMap: convertToParamMap({ order: 'VLR-OLD' }) } } });
    const page = createCheckoutFixture().componentInstance;
    await Promise.resolve();
    expect(loadPaymentOrder).toHaveBeenCalledWith('VLR-OLD', undefined);
    expect(page.order()?.orderId).toBe('order-uuid');
    expect(page.order()?.total).toBe(790000);
    page.place();
    expect(checkoutMember).not.toHaveBeenCalled();
    expect(checkoutGuest).not.toHaveBeenCalled();
    expect(page.step()).toBe('result');
    expect(page.paymentResult()).toBe('confirming');
  });

  it('does not turn a denied existing-order lookup into a new checkout', async () => {
    loadPaymentOrder.mockRejectedValue(new Error('Order ownership denied'));
    const route = stubActivatedRoute();
    TestBed.overrideProvider(ActivatedRoute, { useValue: { ...route, snapshot: { ...route.snapshot, queryParamMap: convertToParamMap({ order: 'other-account-order' }) } } });
    const page = createCheckoutFixture().componentInstance;
    await Promise.resolve();
    expect(page.error()).toBe('Order ownership denied');
    expect(page.resumeLocked()).toBe(true);
    page.place();
    expect(checkoutMember).not.toHaveBeenCalled();
    expect(checkoutGuest).not.toHaveBeenCalled();
  });

  it('blocks an unavailable gateway before an order can be created', () => {
    const page = createCheckoutFixture().componentInstance;
    vi.spyOn(page, 'validateCheckout').mockReturnValue(true);
    page.payment = 'MOMO';
    page.place();
    expect(checkoutGuest).not.toHaveBeenCalled();
    expect(page.error()).toContain('chưa khả dụng');
  });

  it('preserves a voucher refusal saved by the cart instead of automatically reapplying a code', () => {
    localStorage.setItem('checkout_voucher_declined', '1');
    const page = createCheckoutFixture().componentInstance;
    expect(page.voucherDeclined()).toBe(true);
    expect(quote).toHaveBeenLastCalledWith(expect.any(Array), 'standard', expect.objectContaining({ decline: true }));
    localStorage.removeItem('checkout_voucher_declined');
  });

  it('requires alternate recipient contact and complete invoice information only when requested', () => {
    const page = createCheckoutFixture().componentInstance;
    page.orderOptions = { is_other_recipient: true, other_name: 'An', other_phone: 'invalid' };
    expect(page.validateCheckout()).toBe(false);
    expect(page.fieldErrors()['options']).toContain('số điện thoại');
    page.orderOptions = { is_vat_invoice: true, vat_company_name: 'Company' };
    expect(page.validateCheckout()).toBe(false);
    expect(page.fieldErrors()['options']).toContain('hóa đơn');
  });
});
