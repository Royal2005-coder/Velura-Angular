import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { CheckoutStore } from '../../core/services/checkout.store';
import { AuthService } from '../../core/services/auth.service';
import { DEMO_LINES, DemoAddress, PurchaseDemoStore } from '../../core/services/purchase-demo.store';
import { stubActivatedRoute } from '../../../testing/storefront-testing';
import { PurchaseFlowPage } from './purchase-flow.page';

describe('PurchaseFlowPage with mocked Model', () => {
  const place = vi.fn();
  const model = {
    member: signal(false),
    userId: signal<string | null>(null),
    ownsOrder: () => false,
    canAccess: () => false,
    addresses: signal<DemoAddress[]>([]),
    orders: signal([]),
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
    model.member.set(false);
    model.userId.set(null);
    model.addresses.set([]);
    model.saveAddress.mockClear();
    await TestBed.configureTestingModule({
      imports: [PurchaseFlowPage],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: stubActivatedRoute() },
        { provide: CheckoutStore, useValue: { readCheckoutItems: () => DEMO_LINES } },
        { provide: AuthService, useValue: { session: () => null } },
        { provide: PurchaseDemoStore, useValue: model },
      ],
    }).compileComponents();
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });
  it('renders the delivery form and inline OTP for guests', () => {
    const fixture = TestBed.createComponent(PurchaseFlowPage);
    fixture.detectChanges();
    expect(fixture.componentInstance.step()).toBe('form');
    expect(fixture.nativeElement.textContent).toContain('Họ tên người nhận');
    expect(fixture.nativeElement.textContent).toContain('Gửi mã OTP');
    expect(fixture.nativeElement.querySelector('[aria-label="Mở sổ địa chỉ"]')).toBeNull();
  });
  it('never displays success on a failed create and ignores duplicate clicks', () => {
    place.mockImplementation(() => {
      throw new Error('Tạo đơn lỗi');
    });
    const fixture = TestBed.createComponent(PurchaseFlowPage);
    const page = fixture.componentInstance;
    model.member.set(true);
    page.address = {
      name: 'Mẫu',
      phone: '0912345678',
      email: '',
      province: 'Mẫu',
      district: 'Mẫu',
      ward: 'Mẫu',
      detail: 'Mẫu',
    };
    page.place();
    page.place();
    vi.advanceTimersByTime(500);
    expect(place).toHaveBeenCalledTimes(1);
    expect(page.step()).toBe('form');
    expect(page.error()).toBe('Tạo đơn lỗi');
    expect(page.order()).toBeNull();
    expect(page.busy()).toBe(false);
  });
  it('requires OTP for guests but allows a member to continue without it', () => {
    const page = TestBed.createComponent(PurchaseFlowPage).componentInstance;
    page.address = {
      name: 'Mẫu',
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
      name: 'Mẫu',
      phone: '0912345678',
      email: '',
      province: 'Mẫu',
      district: 'Mẫu',
      ward: 'Mẫu',
      detail: 'Mẫu',
    };
    expect(page.validateCheckout()).toBe(true);
  });
  it('shows the User address book instead of OTP and prefills the current account default', () => {
    model.member.set(true);
    model.userId.set('a');
    model.addresses.set([{ name: 'A', phone: '0901234567', email: '', province: 'HCM', district: 'Q1', ward: 'P1', detail: 'Địa chỉ A', isDefault: true }]);
    const fixture = TestBed.createComponent(PurchaseFlowPage);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Gửi mã OTP');
    expect(fixture.nativeElement.querySelector('[aria-label="Mở sổ địa chỉ"]')).not.toBeNull();
    expect(fixture.componentInstance.address.detail).toBe('Địa chỉ A');
  });
  it('invalidates Guest OTP when the delivery phone changes', () => {
    const page = TestBed.createComponent(PurchaseFlowPage).componentInstance;
    page.otpPhone.set('0901234567');
    page.otpVerified.set(true);
    page.editField('phone', '0912345678');
    expect(page.otpVerified()).toBe(false);
    expect(page.otpPhone()).toBe('');
  });
  it('uses a User address for this order without saving when the option is off', () => {
    model.member.set(true);
    const page = TestBed.createComponent(PurchaseFlowPage).componentInstance;
    vi.spyOn(page, 'closeAddressBook').mockImplementation(() => {});
    page.addressDraft = { name: 'A', phone: '0901234567', email: '', province: 'HCM', district: 'Q1', ward: 'P1', detail: 'Địa chỉ mới' };
    page.saveDraft = false;
    page.useDraftAddress();
    expect(page.address.detail).toBe('Địa chỉ mới');
    expect(model.saveAddress).not.toHaveBeenCalled();
  });
});
