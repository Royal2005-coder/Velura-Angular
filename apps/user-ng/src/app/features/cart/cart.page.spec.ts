import { TestBed } from '@angular/core/testing';
import { createStorefrontPage } from '../../../testing/storefront-testing';
import { Router } from '@angular/router';
import { CartStore } from '../../core/services/cart.store';
import { CartPage } from './cart.page';

describe('CartPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(CartPage);
    expect(page).toBeTruthy();
  });

  it('starts empty: computed pager and selection stay at the empty-cart contract', async () => {
    const page = await createStorefrontPage(CartPage);
    expect(page.groupedCount()).toBe(0);
    expect(page.showPagination()).toBe(false);
    expect(page.allSelected()).toBe(false);
    expect(page.selectedSubtotal()).toBe(0);
    expect(page.totalPages()).toBe(1);
  });

  it('mang mã đã chọn ở giỏ sang trang thanh toán thay vì xoá đi', async () => {
    const page = await createStorefrontPage(CartPage);
    TestBed.inject(CartStore).addItem(
      { variant_id: 'v1', product_id: 'p1', product_name: 'Áo linen', product_image: '', quantity: 1, unit_price: 300000 },
      { silent: true },
    );
    page.toggleAll({ target: { checked: true } } as unknown as Event);
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    page.onVoucherApplied({ voucher_id: 'v-ao', code: 'AO20', name: 'Giảm 20% áo', discount_amount: 40000, discount_type: 'percentage' });
    localStorage.setItem('checkout_voucher_declined', '1');

    page.checkout();

    expect(localStorage.getItem('checkout_voucher_id')).toBe('v-ao');
    expect(localStorage.getItem('checkout_voucher_declined')).toBeNull();
  });

  it('khách bỏ mã ở giỏ thì trang thanh toán không tự áp lại', async () => {
    const page = await createStorefrontPage(CartPage);
    TestBed.inject(CartStore).addItem(
      { variant_id: 'v1', product_id: 'p1', product_name: 'Áo linen', product_image: '', quantity: 1, unit_price: 300000 },
      { silent: true },
    );
    page.toggleAll({ target: { checked: true } } as unknown as Event);
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    page.onVoucherApplied(null);
    page.onVoucherDeclined(true);

    page.checkout();

    expect(localStorage.getItem('checkout_voucher_id')).toBeNull();
    expect(localStorage.getItem('checkout_voucher_declined')).toBe('1');
  });

  it('tiền giảm ước tính ở giỏ không trừ mã miễn phí vận chuyển', async () => {
    const page = await createStorefrontPage(CartPage);
    page.onVoucherApplied({ voucher_id: 'v-fs', code: 'FREESHIP', name: 'Miễn phí vận chuyển', discount_amount: 30000, discount_type: 'free_shipping' });
    expect(page.estimatedDiscount()).toBe(0);
  });
});
