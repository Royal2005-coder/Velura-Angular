import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService } from './auth.service';
import { UserSession } from '../models/user-session.interface';
import {
  DEMO_LINES,
  DemoAddress,
  PurchaseDemoStore,
  canCancel,
  maskPhone,
  normalizePhone,
  validPhone,
  withinReturnWindow,
} from './purchase-demo.store';

const address: DemoAddress = {
  name: 'Khách thử',
  phone: '0901234567',
  email: '',
  province: 'TP.HCM',
  district: 'Quận 1',
  ward: 'Bến Nghé',
  detail: 'Địa chỉ mẫu',
};

describe('PurchaseDemoStore BA rules', () => {
  let model: PurchaseDemoStore;
  const session = signal<UserSession | null>(null);
  const user: UserSession = {
    userId: 'user-a',
    fullName: 'A',
    phone: null,
    email: null,
    avatarUrl: null,
  };
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T00:00:00Z'));
    session.set(user);
    TestBed.configureTestingModule({
      providers: [{ provide: AuthService, useValue: { session } }],
    });
    model = TestBed.inject(PurchaseDemoStore);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('normalizes VN phones and masks only the final three digits', () => {
    expect(normalizePhone('+84 901 234 567')).toBe('0901234567');
    expect(validPhone('0123456789')).toBe(false);
    expect(maskPhone('0901234567')).toBe('0901234***');
  });
  it('enforces resend cooldown, six digits, expiry and ownership without creating an account', () => {
    session.set(null);
    model.sendOtp(address.phone);
    expect(() => model.sendOtp(address.phone)).toThrow();
    expect(() => model.verifyOtp('1234')).toThrow();
    model.verifyOtp('123456');
    expect(model.verifiedPhone()).toBe(address.phone);
    expect(model.member()).toBe(false);
    vi.advanceTimersByTime(300001);
    expect(() => model.verifyOtp('123456')).toThrow(/hết hạn/);
  });
  it('locks OTP after five incorrect attempts', () => {
    model.sendOtp(address.phone);
    for (let i = 0; i < 5; i++) expect(() => model.verifyOtp('000000')).toThrow();
    expect(() => model.verifyOtp('123456')).toThrow(/5 lần/);
  });
  it('blocks a guest checkout using a different phone after verification', () => {
    session.set(null);
    model.sendOtp(address.phone);
    model.verifyOtp('123456');
    expect(() => model.place(DEMO_LINES, { ...address, phone: '0912345678' }, 'COD')).toThrow(
      /xác thực/,
    );
    expect(model.orders()).toHaveLength(0);
  });
  it('retains exactly one order through failed, expired, retry and COD transitions', () => {
    const order = model.place(DEMO_LINES, address, 'VNPAY');
    model.paymentResult(order.id, 'failed');
    model.paymentResult(order.id, 'expired');
    model.paymentResult(order.id, 'pending');
    model.useCod(order.id);
    expect(model.orders()).toHaveLength(1);
    expect(model.activeOrder()?.id).toBe(order.id);
    expect(model.activeOrder()?.status).toBe('pending');
    expect(model.activeOrder()?.payment).toBe('COD');
  });
  it('ignores stale failure callbacks after a successful payment', () => {
    const order = model.place(DEMO_LINES, address, 'VNPAY');
    model.paymentResult(order.id, 'paid');
    model.paymentResult(order.id, 'failed');
    model.useCod(order.id);
    expect(model.activeOrder()?.paymentState).toBe('paid');
    expect(model.activeOrder()?.payment).toBe('VNPAY');
  });
  it('rechecks cancellation when preparation begins while the confirmation is open', () => {
    const order = model.place(DEMO_LINES, address, 'COD');
    expect(canCancel(order)).toBe(true);
    model.scenario(order.id, 'preparing');
    expect(() => model.cancel(order.id, 'Khác')).toThrow(/chuẩn bị/);
    expect(model.activeOrder()?.status).toBe('preparing');
  });
  it('refunds only paid online cancellations', () => {
    const cod = model.place(DEMO_LINES, address, 'COD');
    model.cancel(cod.id, 'Khác');
    expect(model.orders().find((row) => row.id === cod.id)?.refund).toBeUndefined();
    const online = model.place(DEMO_LINES, address, 'VNPAY');
    model.paymentResult(online.id, 'paid');
    model.cancel(online.id, 'Khác');
    expect(model.activeOrder()?.refund).toBe('pending');
  });
  it('allows exactly 30 elapsed days and fails closed without delivered_at', () => {
    const order = model.place(DEMO_LINES, address, 'COD');
    model.scenario(order.id, 'delivered', 30);
    expect(withinReturnWindow(model.activeOrder()!)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(withinReturnWindow(model.activeOrder()!)).toBe(false);
    expect(withinReturnWindow({ ...order, status: 'delivered' })).toBe(false);
  });
  it('caps each product at two requests, reserving active quantities and rejecting oversized requests', () => {
    const order = model.place(DEMO_LINES, address, 'COD');
    model.scenario(order.id, 'delivered');
    const variantId = order.items[0].variant_id;
    expect(() =>
      model.createReturn(order.id, 'refund', [{ variantId, quantity: 2 }], '', []),
    ).toThrow(/số lượng/);
    for (let count = 0; count < 2; count++) {
      const request = model.createReturn(
        order.id,
        'exchange',
        [{ variantId, quantity: 1, replacement: 'L / Kem' }],
        '',
        [],
      );
      expect(() =>
        model.createReturn(order.id, 'refund', [{ variantId, quantity: 1 }], '', []),
      ).toThrow();
      for (let stage = 0; stage < 7; stage++) model.advanceRequest(request.id);
    }
    expect(() =>
      model.createReturn(order.id, 'refund', [{ variantId, quantity: 1 }], '', []),
    ).toThrow();
    expect(model.activeOrder()?.items[1].returnCount).toBe(0);
  });
  it('does not require bank data at COD submission and persists only a masked account', () => {
    const order = model.place(DEMO_LINES, address, 'COD');
    model.scenario(order.id, 'delivered');
    const request = model.createReturn(
      order.id,
      'refund',
      [{ variantId: order.items[0].variant_id, quantity: 1 }],
      '',
      [],
    );
    for (let stage = 0; stage < 4; stage++) model.advanceRequest(request.id);
    expect(() => model.advanceRequest(request.id)).toThrow(/bổ sung/);
    model.saveBank(request.id, 'Ngân hàng mẫu', '1234567890', 'KHACH THU');
    model.advanceRequest(request.id);
    expect(sessionStorage.getItem('velura-ui-demo-returns')).not.toContain('1234567890');
    expect(model.requests()[0].bank?.last4).toBe('7890');
  });
  it('chooses the maximum eligible offer and reprices an expired voucher', () => {
    expect(model.quote(DEMO_LINES).discount).toBe(84000);
    expect(model.quote([DEMO_LINES[0]]).discount).toBe(30000);
    model.voucherAvailable.set(false);
    expect(model.quote(DEMO_LINES).discount).toBe(0);
  });
  it('isolates address books and historical orders across account changes and logout', () => {
    model.saveAddress(address);
    const order = model.place(DEMO_LINES, address, 'COD');
    expect(model.ownsOrder(order)).toBe(true);
    session.set({ ...user, userId: 'user-b' });
    expect(model.addresses()).toEqual([]);
    expect(model.ownsOrder(order)).toBe(false);
    expect(() => model.cancel(order.id, 'Khác')).toThrow(/chủ đơn/);
    model.saveAddress({ ...address, detail: 'Địa chỉ B' });
    session.set(user);
    expect(model.addresses()[0].detail).toBe(address.detail);
    session.set(null);
    expect(model.member()).toBe(false);
    expect(model.addresses()).toEqual([]);
    expect(() => model.saveAddress(address)).toThrow(/đăng nhập/);
  });
  it('never persists Guest delivery data or changes Guest into User after OTP or activation', () => {
    session.set(null);
    model.sendOtp(address.phone);
    model.verifyOtp('123456');
    const order = model.place(DEMO_LINES, address, 'COD');
    model.activateAccount(address.phone);
    expect(model.member()).toBe(false);
    expect(order.userId).toBeUndefined();
    expect(model.canAccess(order)).toBe(true);
    expect(sessionStorage.getItem('velura-ui-demo-orders')).not.toContain(address.phone);
    expect(model.addresses()).toEqual([]);
  });
  it('does not expose account orders to Guest OTP for the same delivery phone', () => {
    const order = model.place(DEMO_LINES, address, 'COD');
    session.set(null);
    model.sendOtp(address.phone);
    model.verifyOtp('123456');
    expect(model.canAccess(order)).toBe(false);
    expect(() => model.cancel(order.id, 'Khác')).toThrow(/chủ đơn/);
  });
  it('rechecks ownership of return requests after switching accounts', () => {
    const order = model.place(DEMO_LINES, address, 'COD');
    model.scenario(order.id, 'delivered');
    const request = model.createReturn(
      order.id,
      'refund',
      [{ variantId: order.items[0].variant_id, quantity: 1 }],
      '',
      [],
    );
    session.set({ ...user, userId: 'user-b' });
    expect(() => model.advanceRequest(request.id)).toThrow(/chủ đơn/);
    expect(() => model.saveBank(request.id, 'Mẫu', '12345678', 'A')).toThrow(/chủ đơn/);
    expect(() =>
      model.createReturn(
        order.id,
        'refund',
        [{ variantId: order.items[1].variant_id, quantity: 1 }],
        '',
        [],
      ),
    ).toThrow(/chủ đơn/);
  });
});
