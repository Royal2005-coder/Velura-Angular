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
    expect(localStorage.getItem('checkout_voucher_declined')).toBe('true');
  });

  it('tiền giảm ước tính ở giỏ không trừ mã miễn phí vận chuyển', async () => {
    const page = await createStorefrontPage(CartPage);
    page.onVoucherApplied({ voucher_id: 'v-fs', code: 'FREESHIP', name: 'Miễn phí vận chuyển', discount_amount: 30000, discount_type: 'free_shipping' });
    expect(page.estimatedDiscount()).toBe(0);
  });

  it('phân tách rõ ràng sub-items khi giỏ hàng có đồng thời 1 sản phẩm đơn và 1 combo set', async () => {
    const page = await createStorefrontPage(CartPage);
    const cart = TestBed.inject(CartStore);

    // 1. Thêm 1 sản phẩm đơn lẻ
    cart.addItem(
      {
        variant_id: 'v-single-1',
        product_id: 'p-single-1',
        product_name: 'Áo Thun Basic',
        product_image: '',
        quantity: 1,
        unit_price: 200000,
        color: 'Đen',
        size: 'L',
      },
      { silent: true },
    );

    // 2. Thêm 1 combo set gồm 2 sản phẩm con
    cart.addItem(
      {
        variant_id: 'combo-set-1',
        product_id: 'p-combo-1',
        product_name: 'Set Phối Đồ Công Sở',
        product_image: '',
        quantity: 1,
        unit_price: 650000,
        is_combo: true,
        sub_items: [
          {
            product_id: 'sub-p-1',
            product_name: 'Áo Sơ Mi Oxford',
            product_image: '',
            variant_id: 'sub-v-1',
            color: 'Trắng',
            size: 'M',
            available_variants: [
              { variant_id: 'sub-v-1', color: 'Trắng', size: 'M', stock_quantity: 10 },
              { variant_id: 'sub-v-2', color: 'Xanh nhạt', size: 'M', stock_quantity: 8 },
              { variant_id: 'sub-v-3', color: 'Trắng', size: 'L', stock_quantity: 5 },
            ],
          },
          {
            product_id: 'sub-p-2',
            product_name: 'Quần Tây Slimfit',
            product_image: '',
            variant_id: 'sub-v-4',
            color: 'Đen',
            size: '32',
            available_variants: [
              { variant_id: 'sub-v-4', color: 'Đen', size: '32', stock_quantity: 12 },
              { variant_id: 'sub-v-5', color: 'Xám', size: '32', stock_quantity: 6 },
            ],
          },
        ],
      },
      { silent: true },
    );

    const grouped = page.groupedItems();
    expect(grouped.length).toBe(2);

    const singleItem = grouped.find((i) => !i.is_combo);
    const comboItem = grouped.find((i) => i.is_combo);

    expect(singleItem).toBeTruthy();
    expect(singleItem?.product_name).toBe('Áo Thun Basic');
    expect(singleItem?.color).toBe('Đen');
    expect(singleItem?.size).toBe('L');

    expect(comboItem).toBeTruthy();
    expect(comboItem?.product_name).toBe('Set Phối Đồ Công Sở');
    expect(comboItem?.sub_items?.length).toBe(2);
    expect(comboItem?.sub_items?.[0].product_name).toBe('Áo Sơ Mi Oxford');
    expect(comboItem?.sub_items?.[1].product_name).toBe('Quần Tây Slimfit');
  });

  it('điều chỉnh variant (màu sắc, size) độc lập cho từng sub-item trong combo không làm ảnh hưởng sản phẩm đơn', async () => {
    const page = await createStorefrontPage(CartPage);
    const cart = TestBed.inject(CartStore);

    cart.addItem(
      {
        variant_id: 'v-single-1',
        product_id: 'p-single-1',
        product_name: 'Áo Thun Basic',
        product_image: '',
        quantity: 1,
        unit_price: 200000,
        color: 'Đen',
        size: 'L',
      },
      { silent: true },
    );

    cart.addItem(
      {
        variant_id: 'combo-set-1',
        product_id: 'p-combo-1',
        product_name: 'Set Phối Đồ Công Sở',
        product_image: '',
        quantity: 1,
        unit_price: 650000,
        is_combo: true,
        sub_items: [
          {
            product_id: 'sub-p-1',
            product_name: 'Áo Sơ Mi Oxford',
            product_image: '',
            variant_id: 'sub-v-1',
            color: 'Trắng',
            size: 'M',
            available_variants: [
              { variant_id: 'sub-v-1', color: 'Trắng', size: 'M', stock_quantity: 10 },
              { variant_id: 'sub-v-2', color: 'Xanh nhạt', size: 'M', stock_quantity: 8 },
            ],
          },
          {
            product_id: 'sub-p-2',
            product_name: 'Quần Tây Slimfit',
            product_image: '',
            variant_id: 'sub-v-4',
            color: 'Đen',
            size: '32',
            available_variants: [
              { variant_id: 'sub-v-4', color: 'Đen', size: '32', stock_quantity: 12 },
              { variant_id: 'sub-v-5', color: 'Xám', size: '32', stock_quantity: 6 },
            ],
          },
        ],
      },
      { silent: true },
    );

    const comboItem = page.groupedItems().find((i) => i.is_combo)!;
    const subAo = comboItem.sub_items![0];

    // Đổi màu sub-item Áo Sơ Mi sang 'Xanh nhạt'
    page.pickComboSubColor(comboItem, subAo, 'Xanh nhạt');

    // Kiểm tra sub-item được cập nhật sang variant_id mới và màu mới
    const updatedCombo = page.groupedItems().find((i) => i.is_combo)!;
    expect(updatedCombo.sub_items![0].variant_id).toBe('sub-v-2');
    expect(updatedCombo.sub_items![0].color).toBe('Xanh nhạt');

    // Đổi màu sub-item Quần Tây sang 'Xám'
    const subQuan = updatedCombo.sub_items![1];
    page.pickComboSubColor(updatedCombo, subQuan, 'Xám');
    const updatedCombo2 = page.groupedItems().find((i) => i.is_combo)!;
    expect(updatedCombo2.sub_items![1].variant_id).toBe('sub-v-5');
    expect(updatedCombo2.sub_items![1].color).toBe('Xám');

    // Kiểm tra sản phẩm đơn lẻ KHÔNG bị ảnh hưởng
    const single = page.groupedItems().find((i) => !i.is_combo)!;
    expect(single.variant_id).toBe('v-single-1');
    expect(single.color).toBe('Đen');
    expect(single.size).toBe('L');
  });
});
