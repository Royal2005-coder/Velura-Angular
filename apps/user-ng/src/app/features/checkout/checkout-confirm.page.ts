import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
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
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly created = this.checkout.readCreatedOrder();
  readonly activationRequired = computed(() => this.created?.activation_required === true);
  readonly verification = signal<'pending' | 'paid' | 'failed'>('pending');
  readonly verificationError = signal('');
  readonly codCreated = computed(() => !!this.created?.order_id && this.created.payment_method?.toUpperCase() === 'COD');
  readonly canThankCustomer = computed(() => this.codCreated() || this.verification() === 'paid');

  readonly isStripeSuccess = computed(() => this.route.snapshot.queryParamMap.get('stripe') === 'success');
  readonly orderCode = computed(() => {
    const qCode = this.route.snapshot.queryParamMap.get('code');
    return qCode || this.created?.order_code || this.created?.order_id || '—';
  });
  readonly paymentLabel = computed(() => {
    if (this.isStripeSuccess()) {
      return this.verification() === 'paid' ? 'Thanh toán trực tuyến (Stripe) — Đã thanh toán' : 'Thanh toán trực tuyến (Stripe) — Chưa xác minh thành công';
    }
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
    if (method === 'STRIPE' || method === 'ONLINE_PAYMENT') {
      return 'Thanh toán trực tuyến qua thẻ (Stripe)';
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
    if (this.isStripeSuccess()) {
      this.verifyPayment();
    }
  }

  /** Only the backend gateway verification can make an online order eligible for thanks. */
  verifyPayment(): void {
      this.verification.set('pending');
      this.verificationError.set('');
      const qp = this.route.snapshot.queryParamMap;
      const sessionId = qp.get('session_id') || undefined;
      const orderId = qp.get('order_id') || this.created?.order_id || undefined;
      const orderCode = qp.get('code') || this.created?.order_code || undefined;
      this.api
        .post<{ paid?: boolean; payment_status?: string }>('/api/user/payments/stripe/verify', {
          session_id: sessionId,
          order_id: orderId,
          order_code: orderCode,
          order_access_token: this.created?.order_access_token,
        })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (result) => this.verification.set(result.paid === true || result.payment_status === 'paid' ? 'paid' : 'pending'),
          error: (error: Error) => { this.verification.set('failed'); this.verificationError.set(error.message || 'Chưa xác minh được thanh toán.'); },
        });
  }
}
