import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CheckoutStore } from '../../core/services/checkout.store';
import { useBodyClass } from '../../core/utils/body-class';

@Component({
  selector: 'app-checkout-confirm-page',
  imports: [RouterLink],
  host: { style: 'display:block' },
  templateUrl: './checkout-confirm.page.html',
})
export class CheckoutConfirmPage {
  private readonly checkout = inject(CheckoutStore);
  private readonly created = this.checkout.readCreatedOrder();
  readonly tempPassword = localStorage.getItem('guest_temp_password');

  readonly orderCode = computed(() => this.created?.order_code || this.created?.order_id || '—');
  readonly paymentLabel = computed(() => {
    const method = this.created?.payment_method || 'COD';
    if (method === 'COD' || method === 'cod') {
      return 'Thanh toán khi nhận hàng (COD)';
    }
    if (method === 'MOMO') {
      return 'Ví điện tử MoMo';
    }
    if (method === 'VNPAY') {
      return 'Cổng thanh toán VNPay';
    }
    return 'Thanh toán trực tuyến';
  });
  readonly deliveryLabel = computed(() => {
    const now = new Date();
    const days = this.created?.shipping_method === 'express' ? 2 : 5;
    now.setDate(now.getDate() + days);
    const dayNames = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
    return `${dayNames[now.getDay()]}, ${now.getDate()} Tháng ${now.getMonth() + 1}, ${now.getFullYear()}`;
  });
  readonly address = computed(() => this.created?.shipping_address || '—');

  constructor() {
    useBodyClass('page-checkout');
    if (this.tempPassword) {
      localStorage.removeItem('guest_temp_password');
    }
  }
}
