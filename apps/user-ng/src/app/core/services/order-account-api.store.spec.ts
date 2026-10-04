import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, Subject, of } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { OrderAccountApiStore } from './order-account-api.store';

const order = { order_id: 'uuid-1', order_code: 'VLR-1', status: 'waiting_payment', payment_method: 'STRIPE', payment_status: 'pending', version: 2, items: [] };
const request = { return_id: 'return-1', tracking_return_code: 'RET-1', order_id: 'uuid-1', order_code: 'VLR-1', status: 'REQUESTED', version: 3 };

describe('OrderAccountApiStore authorization and response ordering', () => {
  const session = signal<{ userId: string } | null>(null);
  const get = vi.fn<(path: string) => Observable<Record<string, unknown>>>();
  const post = vi.fn<(path: string, body: unknown) => Observable<Record<string, unknown>>>();
  const patch = vi.fn<(path: string, body: unknown) => Observable<Record<string, unknown>>>();
  beforeEach(() => {
    sessionStorage.clear(); localStorage.clear(); session.set(null);
    get.mockReset(); post.mockReset(); patch.mockReset();
    get.mockImplementation((path) => of(path.includes('/returns') ? { returns: [request] } : { orders: [order] }));
    post.mockReturnValue(of({ success: true })); patch.mockReturnValue(of({ success: true }));
    TestBed.configureTestingModule({ providers: [OrderAccountApiStore,
      { provide: AuthService, useValue: { session, isLoggedIn: () => session() !== null } },
      { provide: ApiService, useValue: { get, post, patch } },
    ] });
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

  async function create(member: string | null = 'A'): Promise<OrderAccountApiStore> {
    session.set(member ? { userId: member } : null);
    const model = TestBed.inject(OrderAccountApiStore);
    TestBed.tick(); await Promise.resolve(); await Promise.resolve();
    return model;
  }

  function restoreGuest(): void {
    sessionStorage.setItem('guest_order_session', JSON.stringify({ token: 'guest-proof', phone: '0901234567', expiresAt: Date.now() + 15 * 60 * 1000 }));
  }

  it('does not relabel a late account A detail response as belonging to account B', async () => {
    const model = await create();
    const pending = new Subject<Record<string, unknown>>();
    get.mockImplementationOnce(() => pending);
    const detail = model.ensureOrderLoaded('VLR-A');
    session.set({ userId: 'B' }); TestBed.tick();
    pending.next({ ...order, order_code: 'VLR-A' });
    await detail;
    expect(model.orders().some((row) => row.id === 'VLR-A')).toBe(false);
    expect(model.orders().every((row) => row.userId === 'B')).toBe(true);
  });

  it('rejects responses from before logout even when the same account logs in again', async () => {
    const model = await create();
    const pending = new Subject<Record<string, unknown>>();
    get.mockImplementationOnce(() => pending);
    const detail = model.ensureOrderLoaded('VLR-OLD');
    session.set(null); TestBed.tick(); session.set({ userId: 'A' }); TestBed.tick();
    pending.next({ ...order, order_code: 'VLR-OLD' }); await detail;
    expect(model.orders().some((row) => row.id === 'VLR-OLD')).toBe(false);
  });

  it('keeps the newest refresh when an older list response arrives last', async () => {
    const model = await create();
    const older = new Subject<Record<string, unknown>>();
    const newer = new Subject<Record<string, unknown>>();
    get.mockImplementation((path) => path === '/api/user/orders' ? older : of({ returns: [] }));
    const first = model.refresh();
    get.mockImplementation((path) => path === '/api/user/orders' ? newer : of({ returns: [] }));
    const second = model.refresh();
    newer.next({ orders: [{ ...order, order_code: 'NEW' }] }); await second;
    older.next({ orders: [{ ...order, order_code: 'OLD' }] }); await first;
    expect(model.orders().map((row) => row.id)).toEqual(['NEW']);
  });

  it('requires OTP before lookup and never treats a delivery contact as authorization', async () => {
    const model = await create(null);
    await expect(model.lookupGuest('VLR-1', '0901234567')).rejects.toThrow('xác thực');
    expect(get).not.toHaveBeenCalled();
  });

  it('forwards the same guest proof through return creation and cancellation', async () => {
    restoreGuest(); const model = await create(null);
    post.mockReturnValueOnce(of({ success: true, return: request }));
    await model.createReturn('VLR-1', 'refund', [], 'Lỗi', []);
    expect(post).toHaveBeenCalledWith('/api/user/returns/guest', expect.objectContaining({ guest_access_token: 'guest-proof', order_code: 'VLR-1' }));
    await model.cancelRequest('RET-1');
    expect(post).toHaveBeenCalledWith('/api/user/returns/guest-cancel', expect.objectContaining({ guest_access_token: 'guest-proof', return_id: 'return-1', expectedVersion: 3 }));
    expect(localStorage.getItem('guest_order_session')).toBeNull();
  });

  it('expires a restored guest session and clears the cached orders after fifteen minutes', async () => {
    vi.useFakeTimers(); restoreGuest(); const model = await create(null);
    expect(model.canAccess(model.orders()[0])).toBe(true);
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(model.verifiedPhone()).toBe(''); expect(model.orders()).toEqual([]);
    expect(sessionStorage.getItem('guest_order_session')).toBeNull();
  });

  it('uses payment facts and eligibility supplied by the backend', async () => {
    get.mockImplementation((path) => of(path.includes('/returns') ? { returns: [] } : { orders: [{ ...order, can_cancel: false, can_request_return: false }] }));
    const model = await create();
    expect(model.orders()[0]).toMatchObject({ status: 'pending_payment', payment: 'STRIPE', paymentState: 'pending', can_cancel: false, can_request_return: false });
  });

  it('verifies one code challenge and reuses its phone session to load every owned order', async () => {
    const model = await create(null);
    post.mockReturnValueOnce(of({ success: true }));
    await model.sendOtp('VLR-1', 'code');
    post.mockReturnValueOnce(of({ success: true, phone: '0901234567', guest_access_token: 'verified-proof' }));
    await model.verifyOtp('123456');
    expect(post).toHaveBeenCalledWith('/api/user/orders/track-otp-send', { order_code: 'VLR-1' });
    expect(post).toHaveBeenCalledWith('/api/user/orders/track-otp-verify', { order_code: 'VLR-1', otp_code: '123456' });
    expect(get).toHaveBeenCalledWith('/api/user/orders/guest?guest_access_token=verified-proof');
    expect(get).toHaveBeenCalledWith('/api/user/returns/guest?order_id=uuid-1&guest_access_token=verified-proof');
    expect(model.canAccess(model.orders()[0])).toBe(true);
    expect(localStorage.getItem('guest_order_session')).toBeNull();
  });

  it('ignores a late guest detail after a member logs in', async () => {
    restoreGuest(); const model = await create(null);
    const pending = new Subject<Record<string, unknown>>(); get.mockReturnValueOnce(pending);
    const detail = model.lookupGuest('VLR-GUEST', '0901234567');
    session.set({ userId: 'B' }); TestBed.tick();
    pending.next({ order: { ...order, order_code: 'VLR-GUEST' } }); await detail;
    expect(model.orders().some((row) => row.id === 'VLR-GUEST')).toBe(false);
    expect(sessionStorage.getItem('guest_order_session')).toBeNull();
  });

  it('preserves canonical support status and never interprets it as a cancellable initial stage', async () => {
    get.mockImplementation((path) => of(path.includes('/returns') ? { returns: [{ ...request, status: 'NEEDS_SUPPORT' }] } : { orders: [order] }));
    const model = await create();
    expect(model.requests()[0]).toMatchObject({ status: 'NEEDS_SUPPORT', stage: -1 });
    await expect(model.cancelRequest('RET-1')).rejects.toThrow('không thể tự hủy');
    expect(post).not.toHaveBeenCalled();
  });

  it('resumes a scoped guest checkout order without exposing a phone-wide order list', async () => {
    const model = await create(null);
    get.mockReturnValueOnce(of({ order }));
    const resumed = await model.loadPaymentOrder('VLR-1', 'order-only-proof');
    expect(get).toHaveBeenCalledWith('/api/user/orders/track?code=VLR-1&guest_access_token=order-only-proof');
    expect(resumed).toMatchObject({ id: 'VLR-1', orderId: 'uuid-1', payment: 'STRIPE', paymentState: 'pending' });
    expect(model.orders()).toEqual([]);
    expect(model.guestAccessToken()).toBe('');
  });

  it('rejects a cold payment resume response after account ownership changes', async () => {
    const model = await create();
    const pending = new Subject<Record<string, unknown>>(); get.mockReturnValueOnce(pending);
    const loading = model.loadPaymentOrder('VLR-1');
    session.set({ userId: 'B' }); TestBed.tick();
    pending.next(order);
    await expect(loading).rejects.toThrow('Phiên xác thực đã thay đổi');
  });

  it('offers only actual available variants of the purchased product and sends the selected UUID', async () => {
    const original = { item_id: 'item-1', variant_id: 'original', product_id: 'product-1', product_name: 'Áo', quantity: 1, unit_price: 100000 };
    get.mockImplementation((path) => of(path.includes('/returns') ? { returns: [] } : path.includes('/products/') ? {
      product_id: 'product-1', variants: [
        { variant_id: 'original', size: 'M', color: 'Đen', stock_quantity: 4 },
        { variant_id: 'replacement', size: 'L', color: 'Đen', stock_quantity: 2 },
        { variant_id: 'empty', size: 'XL', color: 'Đen', stock_quantity: 0 },
      ],
    } : { orders: [{ ...order, items: [original] }] }));
    const model = await create(); await model.loadReplacementChoices('VLR-1');
    const line = model.orders()[0].items[0];
    expect(model.replacementChoices(line)).toEqual([{ id: 'replacement', label: 'L / Đen', stock: 2 }]);
    post.mockReturnValueOnce(of({ success: true, return: { ...request, return_type: 'exchange' } }));
    await model.createReturn('VLR-1', 'exchange', [{ variantId: 'original', quantity: 1, replacementVariantId: 'replacement', replacement: 'L / Đen' }], '', [], 'size');
    expect(post).toHaveBeenCalledWith('/api/user/returns', expect.objectContaining({ reason_code: 'size', evidence_images: [], items: [{ order_item_id: 'item-1', quantity: 1, replacement_variant_id: 'replacement' }] }));
    await expect(model.createReturn('VLR-1', 'exchange', [{ variantId: 'original', quantity: 3, replacementVariantId: 'replacement' }], '', [])).rejects.toThrow('còn đủ số lượng');
    await expect(model.createReturn('VLR-1', 'exchange', [{ variantId: 'original', quantity: 1, replacementVariantId: 'foreign-product' }], '', [])).rejects.toThrow('cùng sản phẩm');
  });
});
