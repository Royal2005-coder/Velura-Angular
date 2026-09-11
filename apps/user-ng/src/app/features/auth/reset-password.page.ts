import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';

@Component({
  selector: 'app-reset-password-page',
  imports: [ReactiveFormsModule, RouterLink],
  host: { class: 'velura-auth-page' },
  templateUrl: './reset-password.page.html',
})
export class ResetPasswordPage {
  private readonly forms = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly errorMessage = signal<string | null>(null);
  readonly successMessage = signal<string | null>(null);
  readonly showPassword = signal(false);
  readonly showConfirm = signal(false);
  readonly submitting = signal(false);

  readonly form = this.forms.nonNullable.group({
    password: ['', [Validators.required, Validators.minLength(8)]],
    password_confirm: ['', Validators.required],
  });

  /**
   * Submits the original reset-password payload after OTP verification.
   */
  submit(): void {
    this.errorMessage.set(null);
    const identity = sessionStorage.getItem('velura_reset_identity');
    const otpCode = sessionStorage.getItem('velura_reset_otp');
    if (!identity || !otpCode) {
      this.errorMessage.set('Phiên xác minh đã hết hạn. Vui lòng thực hiện lại.');
      window.setTimeout(() => void this.router.navigateByUrl('/auth/forgot-password'), 1200);
      return;
    }
    if (this.form.controls.password.value !== this.form.controls.password_confirm.value) {
      this.errorMessage.set('Mật khẩu xác nhận không khớp.');
      return;
    }
    this.submitting.set(true);
    this.api
      .post<unknown>('/api/user/auth/reset-password', {
        identity,
        otp_code: otpCode,
        password: this.form.controls.password.value,
      })
      .subscribe({
        next: () => {
          sessionStorage.removeItem('velura_reset_identity');
          sessionStorage.removeItem('velura_reset_otp');
          this.submitting.set(false);
          this.successMessage.set('Đặt lại mật khẩu thành công! Vui lòng đăng nhập lại.');
          window.setTimeout(() => void this.router.navigateByUrl('/auth/signin'), 1500);
        },
        error: (error: Error) => {
          this.submitting.set(false);
          this.errorMessage.set(error.message || 'Đặt lại mật khẩu thất bại. Vui lòng thử lại.');
        },
      });
  }
}
