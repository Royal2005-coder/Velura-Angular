import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { AuthOtpModal, AuthOtpResult } from '../../shared/auth-otp-modal/auth-otp-modal';

@Component({
  selector: 'app-forgot-password-page',
  imports: [ReactiveFormsModule, RouterLink, AuthOtpModal],
  host: { class: 'velura-auth-page' },
  templateUrl: './forgot-password.page.html',
})
export class ForgotPasswordPage {
  private readonly forms = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly errorMessage = signal<string | null>(null);
  readonly successMessage = signal<string | null>(null);
  readonly submitting = signal(false);
  readonly otpOpen = signal(false);
  readonly otpIdentity = signal('');

  readonly form = this.forms.nonNullable.group({
    identity: ['', Validators.required],
  });

  /**
   * Requests a recovery code from the original forgot-password API.
   */
  submit(): void {
    this.errorMessage.set(null);
    this.successMessage.set(null);
    this.submitting.set(true);
    const identity = this.form.controls.identity.value;
    this.api.post<{ message?: string }>('/api/user/auth/otp-send', { identity }).subscribe({
      next: () => {
        this.submitting.set(false);
        this.otpIdentity.set(identity);
        this.otpOpen.set(true);
      },
      error: (error: Error) => {
        this.submitting.set(false);
        this.errorMessage.set(error.message || 'Không tìm thấy tài khoản.');
      },
    });
  }

  /**
   * Stores the verified reset OTP and continues to the original reset page.
   */
  onOtpVerified(result: AuthOtpResult): void {
    sessionStorage.setItem('velura_reset_identity', this.otpIdentity());
    sessionStorage.setItem('velura_reset_otp', result.otpCode);
    this.otpOpen.set(false);
    void this.router.navigateByUrl('/auth/reset-password');
  }

  /**
   * Closes the original OTP dialog without resetting the password.
   */
  onOtpCancelled(): void {
    this.otpOpen.set(false);
  }
}
