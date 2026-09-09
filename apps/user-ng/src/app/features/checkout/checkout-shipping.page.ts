import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { CheckoutStore } from '../../core/services/checkout.store';
import { formatVnd } from '../../core/utils/money';
import { showToast } from '../../core/utils/toast';
import { useBodyClass } from '../../core/utils/body-class';

interface MemberProfile {
  full_name?: string;
  email?: string;
  phone?: string;
  saved_addresses?: Array<{
    name?: string;
    phone?: string;
    detail?: string;
    address?: string;
    is_default?: boolean;
  }>;
}

interface PlaceOrderResponse {
  success?: boolean;
  message?: string;
  order?: {
    order_id?: string;
    tracking_code?: string;
    payment_method?: string;
    shipping_address?: string;
  };
}

@Component({
  selector: 'app-checkout-shipping-page',
  imports: [RouterLink],
  host: { style: 'display:block' },
  templateUrl: './checkout-shipping.page.html',
})
export class CheckoutShippingPage {
  private readonly checkout = inject(CheckoutStore);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly submitting = signal(false);
  readonly payment = signal(this.checkout.methods().paymentMethod === 'MOMO' ? 'momo' : this.checkout.methods().paymentMethod === 'VNPAY' ? 'vnpay' : 'cod');
  readonly shipping = signal(this.checkout.methods().shippingMethod || 'standard');
  readonly name = signal(this.checkout.shipping().name);
  readonly phone = signal(this.checkout.shipping().phone);
  readonly email = signal(this.checkout.shipping().email);
  readonly province = signal('');
  readonly district = signal('');
  readonly ward = signal('');
  readonly detail = signal(this.checkout.shipping().address);
  readonly note = signal(this.checkout.shipping().note || '');

  readonly items = computed(() => this.checkout.readCheckoutItems());
  readonly subtotal = computed(() => this.items().reduce((sum, line) => sum + line.unit_price * line.quantity, 0));
  readonly freeship = computed(() => this.subtotal() >= 500000);
  readonly shippingFee = computed(() => {
    if (this.freeship() || !this.subtotal()) {
      return 0;
    }
    return this.shipping() === 'express' ? 50000 : 30000;
  });
  readonly total = computed(() => this.subtotal() + this.shippingFee());
  readonly subtotalLabel = computed(() => formatVnd(this.subtotal()) || '0 đ');
  readonly shippingLabel = computed(() => (this.shippingFee() === 0 ? 'Miễn phí' : formatVnd(this.shippingFee())));
  readonly totalLabel = computed(() => formatVnd(this.total()) || '0 đ');
  readonly standardFeeLabel = computed(() => (this.freeship() ? 'Miễn phí' : '30.000đ / Freeship từ 500.000đ'));
  readonly expressFeeLabel = computed(() => (this.freeship() ? 'Miễn phí' : '50.000đ / Freeship từ 500.000đ'));
  readonly submitLabel = computed(() =>
    this.auth.isLoggedIn() ? 'Xác nhận đặt hàng' : 'Nhận mã OTP & Đặt hàng',
  );

  constructor() {
    useBodyClass('page-checkout');
    if (this.auth.isLoggedIn()) {
      this.api
        .get<MemberProfile>('/api/user/profile')
        .pipe(catchError(() => of(null)))
        .subscribe((profile) => this.prefillProfile(profile));
    }
  }

  /**
   * Updates a shipping form field from the original checkout inputs.
   */
  setField(field: 'name' | 'phone' | 'email' | 'province' | 'district' | 'ward' | 'detail' | 'note', event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    const fields = {
      name: this.name,
      phone: this.phone,
      email: this.email,
      province: this.province,
      district: this.district,
      ward: this.ward,
      detail: this.detail,
      note: this.note,
    };
    fields[field].set(value);
  }

  /**
   * Selects a shipping option from the original option cards.
   */
  setShipping(value: string): void {
    this.shipping.set(value);
  }

  /**
   * Selects a payment option from the original option cards.
   */
  setPayment(value: string): void {
    this.payment.set(value);
  }

  /**
   * Saves shipping fields and places the order or sends guest OTP.
   */
  submit(): void {
    if (this.submitting()) {
      return;
    }
    const name = this.name().trim();
    const phone = this.phone().trim();
    const email = this.email().trim();
    const address = this.composeAddress();
    if (!name || !phone || !address) {
      showToast('Vui lòng điền đầy đủ Họ tên, Số điện thoại và Địa chỉ giao hàng!');
      return;
    }
    if (!/^0\d{9}$/.test(phone.replace(/\s/g, ''))) {
      showToast('Số điện thoại không hợp lệ (10 số, bắt đầu bằng 0)!');
      return;
    }
    const items = this.items();
    if (!items.length) {
      showToast('Giỏ hàng không có sản phẩm để thanh toán.');
      return;
    }
    const paymentMethod = this.payment().toUpperCase();
    this.checkout.saveShipping({ name, phone, email, address, note: this.note().trim() });
    this.checkout.saveMethods({
      shippingMethod: this.shipping(),
      shippingFee: this.shippingFee(),
      paymentMethod,
    });

    const payload = {
      shipping_name: name,
      shipping_phone: phone,
      shipping_address: address,
      shipping_fee: this.shippingFee(),
      voucher_id: localStorage.getItem('checkout_voucher_id') || null,
      discount_amount: Number(localStorage.getItem('checkout_discount') || 0),
      subtotal: this.subtotal(),
      total_amount: this.total(),
      payment_method: paymentMethod,
      shipping_email: email,
      items,
    };

    this.submitting.set(true);
    if (this.auth.isLoggedIn()) {
      this.api.post<PlaceOrderResponse>('/api/user/orders', payload).subscribe({
        next: (res) => {
          if (!res.success || !res.order) {
            this.submitting.set(false);
            showToast(res.message || 'Đặt hàng thất bại');
            return;
          }
          this.finishOrder(res.order, items, paymentMethod);
        },
        error: (error: Error) => {
          this.submitting.set(false);
          showToast(error.message || 'Đặt hàng thất bại');
        },
      });
      return;
    }

    this.api
      .post<{ success?: boolean; message?: string }>('/api/user/orders/otp-send', {
        phone,
        email,
        full_name: name,
      })
      .subscribe({
        next: (res) => {
          this.submitting.set(false);
          if (!res.success) {
            showToast(res.message || 'Không thể gửi mã xác thực');
            return;
          }
          this.checkout.saveGuestPayload({
            phone,
            shipping_name: name,
            shipping_address: address,
            shipping_fee: this.shippingFee(),
            voucher_id: payload.voucher_id,
            discount_amount: payload.discount_amount,
            subtotal: payload.subtotal,
            total_amount: payload.total_amount,
            payment_method: paymentMethod,
            email,
            items,
          });
          showToast('Mã xác thực OTP đã được gửi!');
          void this.router.navigateByUrl('/checkout/otp');
        },
        error: (error: Error) => {
          this.submitting.set(false);
          showToast(error.message || 'Không thể gửi mã xác thực');
        },
      });
  }

  private composeAddress(): string {
    const existing = this.detail().trim();
    const parts = [existing, this.ward().trim(), this.district().trim(), this.province().trim()].filter(Boolean);
    if (parts.length > 1) {
      return parts.join(', ');
    }
    return existing;
  }

  private prefillProfile(profile: MemberProfile | null): void {
    if (!profile) {
      return;
    }
    const addr = (profile.saved_addresses || []).find((row) => row.is_default) || profile.saved_addresses?.[0];
    if (!this.name() && profile.full_name) {
      this.name.set(profile.full_name);
    }
    if (!this.phone() && profile.phone) {
      this.phone.set(profile.phone);
    }
    if (!this.email() && profile.email) {
      this.email.set(profile.email);
    }
    if (!this.detail() && addr) {
      this.name.set(this.name() || addr.name || profile.full_name || '');
      this.phone.set(this.phone() || addr.phone || profile.phone || '');
      this.detail.set(addr.detail || addr.address || '');
    }
  }

  private finishOrder(
    order: NonNullable<PlaceOrderResponse['order']>,
    items: ReturnType<CheckoutShippingPage['items']>,
    paymentMethod: string,
  ): void {
    this.checkout.saveCreatedOrder({
      order_id: order.order_id,
      tracking_code: order.tracking_code,
      payment_method: order.payment_method,
      shipping_address: order.shipping_address,
      shipping_method: this.shipping(),
    });
    this.checkout.completeCheckout(items);
    showToast('Đặt hàng thành công!');
    this.submitting.set(false);
    void this.router.navigateByUrl('/checkout/confirm');
    void paymentMethod;
  }
}
