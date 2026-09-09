import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { WishlistStore } from '../../core/services/wishlist.store';
import { showToast } from '../../core/utils/toast';
import { AuthOtpModal, AuthOtpResult } from '../../shared/auth-otp-modal/auth-otp-modal';

@Component({
  selector: 'app-sign-in-page',
  imports: [ReactiveFormsModule, RouterLink, AuthOtpModal],
  host: { class: 'velura-auth-page' },
  templateUrl: './sign-in.page.html',
})
export class SignInPage {
  private readonly forms = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly wishlist = inject(WishlistStore);
  private readonly router = inject(Router);

  readonly method = signal<'phone' | 'email'>('phone');
  readonly errorMessage = signal<string | null>(null);
  readonly showEmailPassword = signal(false);
  readonly showPhonePassword = signal(false);
  readonly submitting = signal(false);
  readonly otpOpen = signal(false);
  readonly otpIdentity = signal('');

  readonly form = this.forms.nonNullable.group({
    email: [''],
    phone: [''],
    password: ['', [Validators.required, Validators.minLength(8)]],
    remember: [false],
  });

  /**
   * Switches between email and phone sign-in panels.
   */
  setMethod(method: 'phone' | 'email'): void {
    this.method.set(method);
  }

  /**
   * Toggles password visibility for the original eye button.
   */
  togglePassword(field: 'email' | 'phone'): void {
    if (field === 'email') {
      this.showEmailPassword.update((open) => !open);
      return;
    }
    this.showPhonePassword.update((open) => !open);
  }

  /**
   * Submits credentials to the existing user auth API.
   */
  submit(): void {
    this.errorMessage.set(null);
    this.submitting.set(true);
    const payload =
      this.method() === 'email'
        ? { email: this.form.controls.email.value, password: this.form.controls.password.value }
        : { phone: this.form.controls.phone.value, password: this.form.controls.password.value };

    const identity =
      this.method() === 'email' ? this.form.controls.email.value : this.form.controls.phone.value;
    this.api
      .post<{ token?: string; user?: Record<string, unknown>; otp_required?: boolean }>('/api/user/auth/signin', payload)
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
   * Completes login after the original OTP dialog verifies.
   */
  onOtpVerified(result: AuthOtpResult): void {
    this.otpOpen.set(false);
    this.finishAuth(result);
  }

  /**
   * Closes the original OTP dialog without signing in.
   */
  onOtpCancelled(): void {
    this.otpOpen.set(false);
  }

  private finishAuth(response: { token?: string; user?: Record<string, unknown> }): void {
    this.auth.applySession(response.token, response.user);
    this.wishlist.refresh();
    showToast('Đăng nhập thành công!');
    void this.router.navigateByUrl('/');
  }
}
