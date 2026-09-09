import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { WishlistStore } from '../../core/services/wishlist.store';
import { showToast } from '../../core/utils/toast';
import { AuthOtpModal, AuthOtpResult } from '../../shared/auth-otp-modal/auth-otp-modal';

@Component({
  selector: 'app-sign-up-page',
  imports: [ReactiveFormsModule, RouterLink, AuthOtpModal],
  host: { class: 'velura-auth-page' },
  templateUrl: './sign-up.page.html',
})
export class SignUpPage {
  private readonly forms = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly wishlist = inject(WishlistStore);
  private readonly router = inject(Router);

  readonly errorMessage = signal<string | null>(null);
  readonly showPassword = signal(false);
  readonly showConfirm = signal(false);
  readonly submitting = signal(false);
  readonly otpOpen = signal(false);
  readonly otpIdentity = signal('');

  readonly form = this.forms.nonNullable.group({
    fullname: ['', Validators.required],
    phone: ['', Validators.required],
    email: [''],
    password: ['', [Validators.required, Validators.minLength(8)]],
    password_confirm: ['', Validators.required],
  });

  /**
   * Creates a member account through the original signup API.
   */
  submit(): void {
    this.errorMessage.set(null);
    if (this.form.controls.password.value !== this.form.controls.password_confirm.value) {
      this.errorMessage.set('Mật khẩu xác nhận chưa khớp.');
      return;
    }
    this.submitting.set(true);
    const identity = this.form.controls.email.value || this.form.controls.phone.value;
    this.api
      .post<{ token?: string; user?: Record<string, unknown>; otp_required?: boolean }>('/api/user/auth/signup', {
        full_name: this.form.controls.fullname.value,
        phone: this.form.controls.phone.value,
        email: this.form.controls.email.value || undefined,
        password: this.form.controls.password.value,
      })
      .subscribe({
        next: (response) => {
          this.submitting.set(false);
          if (response.otp_required) {
            this.otpIdentity.set(identity);
            this.otpOpen.set(true);
            return;
          }
          this.finishAuth(response);
        },
        error: (error: Error) => {
          this.submitting.set(false);
          this.errorMessage.set(error.message);
        },
      });
  }

  /**
   * Completes signup after the original OTP dialog verifies.
   */
  onOtpVerified(result: AuthOtpResult): void {
    this.otpOpen.set(false);
    this.finishAuth(result);
  }

  /**
   * Closes the original OTP dialog without creating a session.
   */
  onOtpCancelled(): void {
    this.otpOpen.set(false);
  }

  private finishAuth(response: { token?: string; user?: Record<string, unknown> }): void {
    this.auth.applySession(response.token, response.user);
    this.wishlist.refresh();
    showToast('Đăng ký tài khoản thành công! Chào mừng bạn đến với Velura 🎉');
    void this.router.navigateByUrl('/');
  }
}
