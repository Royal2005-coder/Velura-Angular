import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { CartLine } from '../../core/services/cart.store';
import { CheckoutStore } from '../../core/services/checkout.store';
import { ApiService } from '../../core/services/api.service';
import { formatVnd } from '../../core/utils/money';
import { showToast } from '../../core/utils/toast';
import { useBodyClass } from '../../core/utils/body-class';

interface OtpVerifyResponse {
  success?: boolean;
  message?: string;
  token?: string;
  user?: Record<string, unknown>;
  temp_password?: string;
  order?: {
    order_id?: string;
    tracking_code?: string;
    payment_method?: string;
    shipping_address?: string;
  };
}

@Component({
  selector: 'app-checkout-otp-page',
  imports: [RouterLink],
  host: { style: 'display:block' },
  templateUrl: './otp.page.html',
})
export class CheckoutOtpPage {
  private readonly checkout = inject(CheckoutStore);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly digits = signal(['', '', '', '']);
  readonly seconds = signal(300);
  readonly errorMessage = signal<string | null>(null);
  readonly submitting = signal(false);
  readonly resending = signal(false);
  readonly maskedEmail = signal(this.readMaskedEmail());
  readonly devBypass = signal(false);
  readonly items = computed(() => this.checkout.readCheckoutItems());
  readonly totalLabel = computed(() => {
    const total = this.items().reduce((sum, line) => sum + line.unit_price * line.quantity, 0);
    return formatVnd(total) || '0 đ';
  });

  constructor() {
    useBodyClass('page-checkout');
    const tick = window.setInterval(() => {
      this.seconds.update((value) => (value > 0 ? value - 1 : 0));
    }, 1000);
    window.setTimeout(() => window.clearInterval(tick), 301000);
  }

  /**
   * Captures one OTP cell and moves focus to the next input.
   */
  onDigit(index: number, event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input.value.replace(/\D/g, '').slice(-1);
    const next = [...this.digits()];
    next[index] = value;
    this.digits.set(next);
    const sibling = input.parentElement?.children[index + 1] as HTMLInputElement | undefined;
    if (value && sibling) {
      sibling.focus();
    }
  }

  /**
   * Resends the original guest checkout OTP.
   */
  resend(): void {
    if (this.resending()) {
      return;
    }
    const payload = this.checkout.readGuestPayload();
    if (!payload) {
      showToast('Thông tin đặt hàng không hợp lệ. Vui lòng thử lại từ đầu.');
      return;
    }
    this.resending.set(true);
    this.api
      .post<{ success?: boolean; masked_email?: string; dev_bypass?: boolean }>('/api/user/orders/otp-send', {
        phone: payload['phone'],
        email: payload['email'] || '',
        full_name: payload['shipping_name'],
      })
      .subscribe({
        next: (res) => {
          this.resending.set(false);
          if (res.success) {
            this.seconds.set(300);
            if (res.masked_email) {
              this.maskedEmail.set(res.masked_email);
            }
            this.devBypass.set(res.dev_bypass === true);
            showToast('Mã OTP mới đã được gửi tới email.');
          } else {
            showToast('Không thể gửi lại mã OTP. Vui lòng thử lại!');
          }
        },
        error: (error: Error) => {
          this.resending.set(false);
          showToast(error.message || 'Lỗi gửi lại mã OTP');
        },
      });
  }

  /**
   * Mailbox shown on the OTP dialog. Empty until the guest payload has an email.
   */
  private readMaskedEmail(): string {
    const email = String(this.checkout.readGuestPayload()?.['email'] || '').trim();
    const at = email.indexOf('@');
    if (at < 1) {
      return '';
    }
    return `${email.slice(0, 1)}***${email.slice(at)}`;
  }

  /**
   * Confirms the original 4-digit checkout OTP and places the guest order.
   */
  confirm(): void {
    const code = this.digits().join('');
    if (code.length < 4) {
      this.errorMessage.set('Vui lòng nhập đầy đủ mã OTP 4 chữ số!');
      return;
    }
    const guestPayload = this.checkout.readGuestPayload();
    if (!guestPayload || !guestPayload['phone']) {
      this.errorMessage.set('Thông tin đặt hàng không hợp lệ. Vui lòng thử lại từ đầu.');
      return;
    }
    this.submitting.set(true);
    this.api
      .post<OtpVerifyResponse>('/api/user/orders/otp-verify', {
        phone: guestPayload['phone'],
        otp: code,
        order: {
          shipping_name: guestPayload['shipping_name'],
          shipping_phone: guestPayload['phone'],
          shipping_address: guestPayload['shipping_address'],
          shipping_fee: guestPayload['shipping_fee'],
          voucher_id: guestPayload['voucher_id'],
          discount_amount: guestPayload['discount_amount'],
          subtotal: guestPayload['subtotal'],
          total_amount: guestPayload['total_amount'],
          payment_method: guestPayload['payment_method'],
          shipping_email: guestPayload['email'] || '',
          items: guestPayload['items'],
        },
      })
      .subscribe({
        next: (res) => {
          this.submitting.set(false);
          if (!res.success || !res.order) {
            this.errorMessage.set(res.message || 'Xác thực OTP không thành công');
            return;
          }
          this.auth.applySession(res.token, res.user);
          if (res.temp_password) {
            localStorage.setItem('guest_temp_password', res.temp_password);
          }
          this.checkout.saveCreatedOrder({
            order_id: res.order.order_id,
            tracking_code: res.order.tracking_code,
            payment_method: res.order.payment_method,
            shipping_address: res.order.shipping_address,
            shipping_method: this.checkout.methods().shippingMethod,
          });
          this.checkout.completeCheckout((guestPayload['items'] as CartLine[]) || []);
          showToast('Thanh toán & Đăng ký thành công!');
          void this.router.navigateByUrl('/checkout/confirm');
        },
        error: (error: Error) => {
          this.submitting.set(false);
          this.errorMessage.set(error.message || 'Lỗi xác thực OTP');
        },
      });
  }
}
