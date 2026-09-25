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
  { variant_id: 'v1', product_id: 'prod-1', product_name: 'Áo linen', color: 'trắng', size: 'M', quantity: 2, unit_price: 160000, product_image: '/assets/images/placeholder.jpg' },
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
  productResult?: (path: string) => ReturnType<ApiService['get']>;
}) {
  sessionStorage.clear();
  localStorage.clear();
  sessionStorage.setItem('checkout_items', JSON.stringify(CART));
  const calls: PostCall[] = [];
  const api = {
    get: (path: string) => {
      if (options.productResult) return options.productResult(path);
      return of({});
    },
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
      provideRouter([{ path: '**', component: class {} }]),
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

  it('cho phép tăng giảm số lượng sản phẩm trực tiếp và gọi tính lại báo giá', async () => {
    const { page, calls, fixture } = await createPage({});
    const initialItem = page.items()[0];
    expect(initialItem.quantity).toBe(2);

    page.changeItemQty(initialItem, 1);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(page.items()[0].quantity).toBe(3);
    const lastQuote = [...calls].reverse().find((call) => call.path === '/api/user/checkout/quote');
    expect(lastQuote?.body['items']).toEqual([{ variant_id: 'v1', quantity: 3 }]);
  });

  it('cho phép xóa sản phẩm khỏi đơn hàng và cập nhật tóm tắt', async () => {
    const { page, fixture } = await createPage({});
    expect(page.items().length).toBe(1);

    page.removeItem(page.items()[0]);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(page.items().length).toBe(0);
  });

  it('cho phép xem và đổi biến thể sản phẩm', async () => {
    const mockVariants = [
      { variant_id: 'v1', color: 'trắng', size: 'M', stock_quantity: 10 },
      { variant_id: 'v2', color: 'đen', size: 'L', stock_quantity: 15 },
    ];
    const { page, fixture } = await createPage({
      productResult: (path) => {
        if (path === '/api/user/products/prod-1') {
          return of({ variants: mockVariants });
        }
        return of({});
      },
    });

    const item = page.items()[0];
    page.toggleVariants(item);
    expect(page.editingVariantId()).toBe('v1');
    expect(page.variantChoices()).toEqual(mockVariants);

    page.pickVariant(item, { variant_id: 'v2', color: 'đen', size: 'L' });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(page.items()[0].variant_id).toBe('v2');
    expect(page.items()[0].color).toBe('đen');
    expect(page.items()[0].size).toBe('L');
    expect(page.editingVariantId()).toBeNull();
  });

  it('đánh dấu biến thể bị thiếu hàng khi đặt đơn gặp lỗi INSUFFICIENT_STOCK', async () => {
    const stockError = new ApiRequestError('Sản phẩm đã hết hàng', 400, 'INSUFFICIENT_STOCK', {
      items: [{ variant_id: 'v1', requested_quantity: 2, stock_quantity: 0 }],
    });
    const { page } = await createPage({
      orderResult: () => throwError(() => stockError),
    });

    fillShipping(page);
    page.submit();

    expect(page.submitting()).toBe(false);
    expect(page.outOfStockVariantIds().has('v1')).toBe(true);
  });

  it('xác nhận thanh toán demo gọi endpoint confirm-payment và cập nhật trạng thái đơn', async () => {
    const { page, calls } = await createPage({});
    page.pendingOrder.set({ order_id: 'ord-123', order_code: 'VLR123456789', payment_method: 'VNPAY' });
    page.pendingItems.set(CART);
    page.qrModalOpen.set(true);

    page.confirmDemoPayment();

    const confirmCall = calls.find((c) => c.path === '/api/user/orders/ord-123/confirm-payment');
    expect(confirmCall).toBeTruthy();
    expect(page.qrModalOpen()).toBe(false);
  });

  it('chuẩn hóa số điện thoại Việt Nam khi autofill hoặc nhập +84', async () => {
    const { page } = await createPage({});
    expect(page.normalizeVnPhone('+84913956506')).toBe('0913956506');
    expect(page.normalizeVnPhone('84913956506')).toBe('0913956506');
    expect(page.normalizeVnPhone('0913 956 506')).toBe('0913956506');
    expect(page.normalizeVnPhone('0084913956506')).toBe('0913956506');

    const fakeInput = document.createElement('input');
    fakeInput.value = '+84913956506';
    page.onPhoneInput('phone', { target: fakeInput } as unknown as Event);
    expect(fakeInput.value).toBe('0913956506');
    expect(page.phone()).toBe('0913956506');
  });

  it('chọn địa chỉ mặc định và chuyển đổi chế độ địa chỉ kiểu Shopee', async () => {
    const { page } = await createPage({});
    const addr = {
      name: 'Nguyễn Văn B',
      phone: '+84987654321',
      detail: '456 Hai Bà Trưng, Phường Bến Nghé, Quận 1',
      is_default: true,
    };
    page.savedAddresses.set([addr]);
    page.selectSavedAddress(addr);

    expect(page.phone()).toBe('0987654321');
    expect(page.addressMode()).toBe('default');
    expect(page.selectedAddressIsDefault()).toBe(true);
    expect(page.composeAddress()).toBe('456 Hai Bà Trưng, Phường Bến Nghé, Quận 1');
  });
});

