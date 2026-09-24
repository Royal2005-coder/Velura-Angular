import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { WishlistStore } from '../../core/services/wishlist.store';
import { showToast } from '../../core/utils/toast';
import { AuthOtpModal, AuthOtpResult } from '../../shared/auth-otp-modal/auth-otp-modal';

const PKCE_STORAGE_KEY = 'velura-user-oauth-pkce-code-verifier';

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
  private readonly route = inject(ActivatedRoute);

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
   * Submits credentials to user auth API.
   * Enables seamless frontend testing fallback if backend is offline.
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

    if (environment.mockAuth) {
      this.signInWithMockAccount(identity);
      return;
    }

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
        error: (err: Error) => {
          this.submitting.set(false);
          this.errorMessage.set(err?.message || 'Không thể kết nối máy chủ. Vui lòng thử lại sau.');
        },
      });
  }

  private signInWithMockAccount(identity: string): void {
    fetch('/mock/member-account.json')
      .then((response) => {
        if (!response.ok) throw new Error('Mock account unavailable');
        return response.json() as Promise<{ email: string; phone: string; password: string; user: Record<string, unknown> }>;
      })
      .then((account) => {
        const matchesIdentity = this.method() === 'email' ? identity === account.email : identity === account.phone;
        if (!matchesIdentity || this.form.controls.password.value !== account.password) {
          throw new Error('Invalid mock credentials');
        }
        this.submitting.set(false);
        this.finishAuth({ token: 'mock-jwt-token-demo', user: account.user });
      })
      .catch(() => {
        this.submitting.set(false);
        this.errorMessage.set('Tài khoản mock không đúng. Dùng thông tin trong mock/member-account.json.');
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

  /**
   * Starts Google PKCE through `/api/auth/google`, same contract as admin login.
   */
  async startGoogle(): Promise<void> {
    this.errorMessage.set(null);
    try {
      const redirectTo = `${window.location.origin}/auth/callback`;
      const verifier = this.randomVerifier();
      const challenge = await this.codeChallenge(verifier);
      localStorage.setItem(PKCE_STORAGE_KEY, verifier);
      const url =
        `${environment.apiUrl}/api/auth/google` +
        `?redirect_to=${encodeURIComponent(redirectTo)}` +
        `&code_challenge=${encodeURIComponent(challenge)}`;
      window.location.href = url;
    } catch {
      this.errorMessage.set('Không thể kết nối Google. Vui lòng thử lại hoặc đăng nhập bằng email.');
    }
  }

  /**
   * Facebook SSO is not wired. Keep the button honest instead of a dead click.
   */
  startFacebook(): void {
    this.errorMessage.set('Đăng nhập Facebook chưa được kết nối. Dùng email, số điện thoại hoặc Google.');
  }

  private finishAuth(response: { token?: string; user?: Record<string, unknown> }): void {
    this.auth.applySession(response.token, response.user);
    this.wishlist.refresh();
    showToast('Đăng nhập thành công!');
    const returnUrl = this.route.snapshot.queryParams['returnUrl'] || '/account/orders';
    void this.router.navigateByUrl(returnUrl);
  }

  private randomVerifier(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return this.base64Url(bytes);
  }

  private async codeChallenge(verifier: string): Promise<string> {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return this.base64Url(new Uint8Array(digest));
  }

  private base64Url(bytes: Uint8Array): string {
    let binary = '';
    bytes.forEach((value) => {
      binary += String.fromCharCode(value);
    });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}
