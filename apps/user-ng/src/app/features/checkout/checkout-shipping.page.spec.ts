import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { createStorefrontPage } from '../../../testing/storefront-testing';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ApiRequestError } from '../../core/models/api-request-error';
import type { CheckoutQuote } from '../../core/models/voucher.interface';
import { CheckoutShippingPage } from './checkout-shipping.page';

const CART = [
  { variant_id: 'v1', product_name: 'Áo linen', color: 'trắng', size: 'M', quantity: 2, unit_price: 160000 },
];

function quote(overrides: Partial<CheckoutQuote> = {}): CheckoutQuote {
  return {
    subtotal: 320000,
    shipping_fee: 30000,
    free_shipping_threshold: 500000,
    free_shipping_shortfall: 180000,
    discount_amount: 20000,
    total_amount: 330000,
    voucher: { voucher_id: 'vc-20', code: 'GIAM20K', name: 'Giảm 20.000đ', discount_amount: 20000 },
    voucher_change: null,
    ...overrides,
  };
}

interface PostCall {
  path: string;
  body: Record<string, unknown>;
}

/**
 * Dựng trang với một API giả: báo giá trả `quoteFor(body)`, đặt đơn trả `orderResult`.
 */
async function createPage(options: {
  quoteFor?: (body: Record<string, unknown>) => CheckoutQuote;
  orderResult?: () => ReturnType<ApiService['post']>;
}) {
  sessionStorage.clear();
  localStorage.clear();
  sessionStorage.setItem('checkout_items', JSON.stringify(CART));
  const calls: PostCall[] = [];
  const api = {
    get: () => of({}),
    patch: () => of({}),
    delete: () => of({}),
    post: (path: string, body: Record<string, unknown>) => {
      calls.push({ path, body });
      if (path === '/api/user/checkout/quote') {
        return of({ success: true, quote: (options.quoteFor ?? (() => quote()))(body) });
      }
      if (path === '/api/user/orders' && options.orderResult) {
        return options.orderResult();
      }
      return of({});
    },
  } as unknown as ApiService;

  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [CheckoutShippingPage],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: { isLoggedIn: () => true } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(CheckoutShippingPage);
  fixture.detectChanges();
  await fixture.whenStable();
  return { page: fixture.componentInstance, fixture, calls };
}

function fillShipping(page: CheckoutShippingPage): void {
  page.name.set('Nguyễn Văn A');
  page.phone.set('0901234567');
  page.email.set('a@velura.test');
  page.detail.set('12 Lê Lợi, Quận 1');
}

describe('CheckoutShippingPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(CheckoutShippingPage);
    expect(page).toBeTruthy();
  });

  it('lấy mọi con số trên màn Tóm tắt đơn từ báo giá của máy chủ', async () => {
    const { page, calls } = await createPage({});
    const quoteCall = calls.find((call) => call.path === '/api/user/checkout/quote');
    expect(quoteCall?.body['items']).toEqual([{ variant_id: 'v1', quantity: 2 }]);
    expect(page.subtotal()).toBe(320000);
    expect(page.shippingFee()).toBe(30000);
    expect(page.discount()).toBe(20000);
    expect(page.total()).toBe(330000);
  });

  it('ngưỡng miễn phí vận chuyển lấy từ máy chủ, không viết cứng', async () => {
    const { page } = await createPage({
      quoteFor: () => quote({ free_shipping_threshold: 700000, free_shipping_shortfall: 380000 }),
    });
    expect(page.freeShippingHint()).toContain('380.000');
    expect(page.standardFeeLabel()).toContain('700.000');
  });

  it('khách bỏ mã thì báo giá gửi decline_voucher và không mang mã nào', async () => {
    const { page, calls, fixture } = await createPage({});
    page.onVoucherApplied(null);
    page.onVoucherDeclined(true);
    fixture.detectChanges();
    await fixture.whenStable();
    const last = [...calls].reverse().find((call) => call.path === '/api/user/checkout/quote');
    expect(last?.body['decline_voucher']).toBe(true);
    expect(last?.body['voucher_id']).toBeNull();
  });

  it('mã vừa hết lượt lúc đặt đơn thì không sang màn thành công mà báo tổng mới', async () => {
    const changed = new ApiRequestError('Mã đã hết lượt sử dụng trên hệ thống.', 409, 'VOUCHER_CHANGED', {
      requested_code: 'GIAM50K',
      reason_text: 'Mã đã hết lượt sử dụng trên hệ thống.',
      replacement: { voucher_id: 'vc-20', code: 'GIAM20K', name: 'Giảm 20.000đ', discount_amount: 20000 },
    });
    const { page } = await createPage({ orderResult: () => throwError(() => changed) });
    page.onVoucherApplied({
      voucher_id: 'vc-50', code: 'GIAM50K', name: 'Giảm 50.000đ', discount_amount: 50000, discount_type: 'fixed_amount',
    });
    fillShipping(page);
    page.submit();

    expect(page.submitting()).toBe(false);
    expect(page.voucherNotice()).toContain('GIAM50K');
    expect(page.voucherNotice()).toContain('GIAM20K');
    expect(page.selectedVoucherId()).toBe('vc-20');
    expect(localStorage.getItem('checkout_voucher_id')).toBe('vc-20');
  });
});
