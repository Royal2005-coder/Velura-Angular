import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { catchError, of, switchMap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AdminApiService } from '../../core/admin-api.service';
import { adminErrorMessage } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';
import { useBodyClass } from '../../core/body-class';

const PKCE_STORAGE_KEY = 'velura-oauth-pkce-code-verifier';

@Component({
  selector: 'app-admin-login-page',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './admin-login.page.html',
  host: { class: 'page-auth' },
})
export class AdminLoginPage {
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionService);
  private readonly router = inject(Router);

  readonly errorMessage = signal<string | null>(null);
  readonly successMessage = signal<string | null>(null);
  readonly submitting = signal(false);

  readonly form = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  constructor() {
    useBodyClass('page-auth');
  }

  /**
   * Submits admin credentials through the same Supabase password grant as vanilla login.
   */
  submit(): void {
    if (this.form.invalid) {
      this.errorMessage.set('Vui lòng nhập đầy đủ email và mật khẩu.');
      return;
    }
    this.errorMessage.set(null);
    this.successMessage.set(null);
    this.submitting.set(true);
    this.api
      .signIn(this.form.controls.email.value, this.form.controls.password.value)
      .pipe(
        switchMap((response) => {
          if (!response.token) {
            throw new Error('Không nhận được phiên đăng nhập.');
          }
          this.session.setToken(response.token);
          return this.api.me();
        }),
        catchError((error: unknown) => {
          this.session.clear();
          this.submitting.set(false);
          this.errorMessage.set(adminErrorMessage(error, 'Email hoặc mật khẩu không hợp lệ.'));
          return of(null);
        }),
      )
      .subscribe((context) => {
        if (!context) {
          return;
        }
        const session = this.session.applyAuthContext(context);
        this.submitting.set(false);
        void this.router.navigateByUrl(this.session.firstRoute(session));
      });
  }

  /**
   * Starts the original Google PKCE authorize redirect.
   */
  async startGoogle(): Promise<void> {
    this.errorMessage.set(null);
    this.successMessage.set(null);
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
      this.errorMessage.set('Không thể kết nối Google SSO. Vui lòng thử lại hoặc đăng nhập bằng email.');
    }
  }

  /**
   * Sends the original forgot-password email through Supabase.
   */
  forgot(event: Event): void {
    event.preventDefault();
    const email = this.form.controls.email.value.trim();
    this.errorMessage.set(null);
    this.successMessage.set(null);
    if (!email) {
      this.errorMessage.set('Nhập email để nhận liên kết đặt lại mật khẩu.');
      return;
    }
    this.api.requestPasswordReset(email).subscribe({
      next: () => this.successMessage.set('Nếu email tồn tại, liên kết đặt lại mật khẩu đã được gửi.'),
      error: () => this.successMessage.set('Nếu email tồn tại, liên kết đặt lại mật khẩu đã được gửi.'),
    });
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
