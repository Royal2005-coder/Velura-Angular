import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
import { VoucherWallet } from './voucher-wallet';
import { VoucherService } from '../../core/services/voucher.service';
import type { AppliedVoucher, WalletVoucher, VoucherApplyResponse, VoucherWalletResponse } from '../../core/models/voucher.interface';

function walletVoucher(overrides: Partial<WalletVoucher> = {}): WalletVoucher {
  return {
    voucher_id: 'v-1',
    promo_id: null,
    code: 'VLR10',
    name: 'Giảm 10%',
    discount_type: 'percentage',
    discount_value: 10,
    max_discount_amount: null,
    min_order_value: 0,
    start_date: null,
    end_date: null,
    remaining_uses: null,
    eligible: true,
    discount_amount: 100000,
    reason: null,
    reason_text: null,
    shortfall: null,
    ...overrides,
  };
}

/** Model giả: component không được tự gọi HttpClient. */
function stubVoucherService(vouchers: WalletVoucher[], bestId: string | null): VoucherService {
  return {
    loadWallet: () =>
      of({
        success: true,
        order_value: 1000000,
        shipping_fee: 30000,
        best_voucher_id: bestId,
        eligible_count: vouchers.filter((item) => item.eligible).length,
        vouchers,
      }),
    pickBest: () => of({ success: true, applied: false }),
    applyCode: () => of({ success: true, applied: false }),
  } as unknown as VoucherService;
}

function createWallet(service: VoucherService, preferred: string | null = null) {
  TestBed.configureTestingModule({
    imports: [VoucherWallet],
    providers: [{ provide: VoucherService, useValue: service }],
  });
  const fixture = TestBed.createComponent(VoucherWallet);
  fixture.componentRef.setInput('orderValue', 1000000);
  fixture.componentRef.setInput('shippingFee', 30000);
  fixture.componentRef.setInput('preferred', preferred);
  fixture.detectChanges();
  return fixture;
}

describe('VoucherWallet', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('tự áp mã tốt nhất khi mở, khách không phải gõ mã', () => {
    const cheap = walletVoucher({ voucher_id: 'v-small', code: 'SMALL', discount_amount: 20000 });
    const best = walletVoucher({ voucher_id: 'v-big', code: 'BIG', discount_amount: 90000 });
    const fixture = createWallet(stubVoucherService([best, cheap], 'v-big'));

    const applied: Array<AppliedVoucher | null> = [];
    fixture.componentInstance.applied.subscribe((value) => applied.push(value));
    fixture.componentInstance.refresh(1000000, 30000);

    expect(fixture.componentInstance.selected()?.code).toBe('BIG');
    expect(applied.at(-1)?.discount_amount).toBe(90000);
  });

  it('giữ mã chưa đủ điều kiện trong danh sách kèm lý do và khoảng còn thiếu', () => {
    const blocked = walletVoucher({
      voucher_id: 'v-block',
      code: 'FREESHIP',
      eligible: false,
      discount_amount: 0,
      reason: 'MIN_ORDER_NOT_MET',
      reason_text: 'Đơn hàng chưa thỏa mãn điều kiện — mua thêm 830.000đ để dùng mã này.',
      shortfall: 830000,
    });
    const fixture = createWallet(stubVoucherService([blocked], null));

    expect(fixture.componentInstance.ineligible().length).toBe(1);
    expect(fixture.componentInstance.nearestGoal()?.shortfall).toBe(830000);
  });

  it('khách chủ động bỏ mã thì hệ thống không tự áp lại', () => {
    const best = walletVoucher({ voucher_id: 'v-big', code: 'BIG', discount_amount: 90000 });
    const fixture = createWallet(stubVoucherService([best], 'v-big'));
    const component = fixture.componentInstance;

    const applied: Array<AppliedVoucher | null> = [];
    component.applied.subscribe((value) => applied.push(value));

    component.clear();
    expect(component.selected()).toBeNull();
    expect(applied.at(-1)).toBeNull();

    component.refresh(1000000, 30000);
    expect(component.selected()).toBeNull();
  });

  it('gợi ý mã lợi hơn khi khách đang chọn mã nhỏ hơn', () => {
    const small = walletVoucher({ voucher_id: 'v-small', code: 'SMALL', discount_amount: 20000 });
    const big = walletVoucher({ voucher_id: 'v-big', code: 'BIG', discount_amount: 90000 });
    const fixture = createWallet(stubVoucherService([big, small], 'v-big'));
    const component = fixture.componentInstance;

    component.choose(small);
    expect(component.betterOption()?.code).toBe('BIG');
  });

  it('hiển thị lỗi khi không tải được ví, không làm vỡ trang', () => {
    const failing = {
      loadWallet: () => throwError(() => new Error('Mạng lỗi')),
      pickBest: () => of({ success: true, applied: false }),
      applyCode: () => of({ success: true, applied: false }),
    } as unknown as VoucherService;

    const fixture = createWallet(failing);
    expect(fixture.componentInstance.loadError()).toBe('Mạng lỗi');
    expect(fixture.componentInstance.items().length).toBe(0);
  });

  it('mã khách mang theo từ trang Ưu đãi được áp thay cho mã tốt nhất', () => {
    const best = walletVoucher({ voucher_id: 'v-big', code: 'BIG', discount_amount: 90000 });
    const chosen = walletVoucher({ voucher_id: 'v-ao', code: 'AO20', discount_amount: 40000 });
    const fixture = createWallet(stubVoucherService([best, chosen], 'v-big'), 'ao20');
    expect(fixture.componentInstance.selected()?.code).toBe('AO20');
    expect(fixture.componentInstance.preferredNotice()).toBeNull();
  });

  it('mã mang theo chưa dùng được thì nói lý do rồi mới áp mã tốt nhất', () => {
    const best = walletVoucher({ voucher_id: 'v-big', code: 'BIG', discount_amount: 90000 });
    const blocked = walletVoucher({
      voucher_id: 'v-ao',
      code: 'AO20',
      eligible: false,
      discount_amount: 0,
      reason: 'CATEGORY_MISMATCH',
      reason_text: 'Mã chỉ áp cho Áo, giỏ hàng chưa có sản phẩm phù hợp.',
    });
    const fixture = createWallet(stubVoucherService([best, blocked], 'v-big'), 'AO20');
    expect(fixture.componentInstance.selected()?.code).toBe('BIG');
    expect(fixture.componentInstance.preferredNotice()).toContain('chỉ áp cho Áo');
  });

  it('mã mang theo không có trong ví thì báo, không im lặng thay mã khác', () => {
    const best = walletVoucher({ voucher_id: 'v-big', code: 'BIG', discount_amount: 90000 });
    const fixture = createWallet(stubVoucherService([best], 'v-big'), 'KHONGCO');
    expect(fixture.componentInstance.preferredNotice()).toContain('KHONGCO');
  });

  it('discards an earlier wallet when the cart request or customer changes', () => {
    const first = new Subject<VoucherWalletResponse>();
    const second = new Subject<VoucherWalletResponse>();
    const customerSession = signal({ userId: 'A' });
    const loadWallet = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const service = { ...stubVoucherService([], null), loadWallet, customerSession } as unknown as VoucherService;
    const fixture = createWallet(service);
    const wallet = fixture.componentInstance;
    wallet.refresh(1000000, 30000);
    const fresh = walletVoucher({ voucher_id: 'fresh', code: 'FRESH' });
    second.next({ success: true, vouchers: [fresh], best_voucher_id: fresh.voucher_id, order_value: 1000000, shipping_fee: 30000, eligible_count: 1 });
    first.next({ success: true, vouchers: [walletVoucher()], best_voucher_id: 'v-1', order_value: 1000000, shipping_fee: 30000, eligible_count: 1 });
    expect(wallet.selected()?.code).toBe('FRESH');
    customerSession.set({ userId: 'B' });
    second.next({ success: true, vouchers: [walletVoucher()], best_voucher_id: 'v-1', order_value: 1000000, shipping_fee: 30000, eligible_count: 1 });
    expect(wallet.selected()?.code).toBe('FRESH');
    loadWallet.mockReturnValue(of({ success: true, vouchers: [], best_voucher_id: null }));
    fixture.detectChanges();
    expect(wallet.items()).toEqual([]);
    expect(wallet.selected()).toBeNull();
  });

  it('clears the parent discount when revalidating the wallet fails', () => {
    const service = stubVoucherService([walletVoucher()], 'v-1');
    const fixture = createWallet(service);
    const emissions: Array<AppliedVoucher | null> = [];
    fixture.componentInstance.applied.subscribe((value) => emissions.push(value));
    vi.spyOn(service, 'loadWallet').mockReturnValue(throwError(() => new Error('Không thể kiểm tra ưu đãi')));
    fixture.componentInstance.refresh(1000000, 30000);
    expect(fixture.componentInstance.selected()).toBeNull();
    expect(emissions.at(-1)).toBeNull();
  });

  it('does not apply a pending manual code to a changed cart', () => {
    const manual = new Subject<VoucherApplyResponse>();
    const service = stubVoucherService([], null);
    vi.spyOn(service, 'applyCode').mockReturnValue(manual);
    const fixture = createWallet(service);
    const wallet = fixture.componentInstance;
    wallet.manualCode.set('PRIVATE');
    const emissions: Array<AppliedVoucher | null> = [];
    wallet.applied.subscribe((value) => emissions.push(value));
    wallet.submitManualCode();
    fixture.componentRef.setInput('orderValue', 2000000);
    manual.next({ success: true, applied: true, voucher_id: 'manual', discount_amount: 100000 });
    expect(emissions).toEqual([]);
    fixture.detectChanges();
    expect(wallet.applying()).toBe(false);
  });

  it('opens the wallet in a modal dialog and closes it on Escape', () => {
    // The DOM test runner omits the browser top-layer API; mock that platform boundary.
    const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
    const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: showModal });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); } });
    try {
    const fixture = createWallet(stubVoucherService([], null));
    fixture.componentInstance.openModal();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    expect(dialog).toBeTruthy();
    expect(dialog.open).toBe(true);
    expect(showModal).toHaveBeenCalledOnce();
    dialog.dispatchEvent(new Event('cancel'));
    fixture.detectChanges();
    expect(fixture.componentInstance.modalOpen()).toBe(false);
    expect(fixture.nativeElement.querySelector('dialog')).toBeNull();
    } finally {
      if (original) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
      if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
    }
  });
});
