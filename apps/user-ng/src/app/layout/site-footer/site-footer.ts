import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { ApiService } from '../../core/services/api.service';

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

@Component({
  selector: 'app-site-footer',
  imports: [RouterLink],
  templateUrl: './site-footer.html',
})
export class SiteFooter {
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);

  /** Tên phương thức thanh toán đang mở tooltip khi chạm trên thiết bị cảm ứng */
  readonly activeTooltip = signal<string | null>(null);

  /** Quản lý trạng thái form đăng ký bản tin và nhận ưu đãi 10% */
  readonly email = signal<string>('');
  readonly honeypot = signal<string>('');
  readonly submitting = signal<boolean>(false);
  readonly statusMessage = signal<string | null>(null);
  readonly errorMessage = signal<string | null>(null);

  /** Modal thông báo đã ghi nhận thành công và yêu cầu kiểm tra email */
  readonly successModalOpen = signal<boolean>(false);
  readonly registeredEmail = signal<string>('');
  readonly isGmail = computed(() => this.registeredEmail().toLowerCase().includes('@gmail.com'));
  /**
   * Bật/tắt hiển thị tooltip khi chạm trên màn hình di động / tablet
   */
  toggleTooltip(name: string): void {
    this.activeTooltip.update((curr) => (curr === name ? null : name));
  }

  /**
   * Cập nhật giá trị ô nhập email
   */
  onEmailInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.email.set(target?.value ?? '');
    if (this.errorMessage()) {
      this.errorMessage.set(null);
    }
  }

  /**
   * Đóng modal thông báo đăng ký thành công
   */
  closeSuccessModal(): void {
    this.successModalOpen.set(false);
  }

  /**
   * Gửi yêu cầu đăng ký nhận tin tức và ưu đãi 10%
   */
  submitNewsletter(event: Event): void {
    event.preventDefault();
    const rawEmail = this.email().trim();

    if (!rawEmail || !EMAIL_REGEX.test(rawEmail)) {
      this.errorMessage.set('Vui lòng nhập địa chỉ email hợp lệ.');
      this.statusMessage.set(null);
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    this.statusMessage.set(null);

    this.api
      .post<{ success: boolean; message: string }>('/api/user/newsletter/subscribe', {
        email: rawEmail,
        source: 'storefront_footer',
        hp_website: this.honeypot()
      })
      .subscribe({
        next: (res) => {
          this.submitting.set(false);
          this.registeredEmail.set(rawEmail);
          this.successModalOpen.set(true);
          this.statusMessage.set(res.message || 'Đã ghi nhận! Vui lòng kiểm tra email của bạn để nhận mã giảm giá 10%.');
          this.email.set('');
        },
        error: (err: unknown) => {
          this.submitting.set(false);
          const msg =
            err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
              ? err.message
              : 'Không thể kết nối đến máy chủ. Vui lòng thử lại sau.';
          this.errorMessage.set(msg);
        }
      });
  }
}
