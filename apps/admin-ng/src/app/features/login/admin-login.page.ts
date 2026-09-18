import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { catchError, of, switchMap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AdminApiService } from '../../core/admin-api.service';
import { adminAuthLockout, adminErrorMessage } from '../../core/admin-http';
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
  private readonly destroyRef = inject(DestroyRef);
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  readonly errorMessage = signal<string | null>(null);
  readonly successMessage = signal<string | null>(null);
  readonly submitting = signal(false);
  readonly remainingAttempts = signal<number | null>(null);
  readonly lockedUntil = signal<number | null>(null);
  readonly remainingLockMs = signal(0);
  readonly isLocked = computed(() => {
    const until = this.lockedUntil();
    return until !== null && until > Date.now();
  });
  readonly lockCountdown = computed(() => formatCountdown(this.remainingLockMs()));

  readonly form = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  constructor() {
    useBodyClass('page-auth');
    this.session.clear();
    this.destroyRef.onDestroy(() => this.stopCountdown());
  }

  /**
   * Submits admin credentials through `/api/auth/signin` so AUTH-02 lockout runs.
   */
  submit(): void {
    if (this.isLocked()) {
      this.errorMessage.set(`Tài khoản của bạn đã bị tạm khóa. Thử lại sau ${this.lockCountdown()}.`);
      return;
    }
    if (this.form.invalid) {
      this.errorMessage.set('Vui lòng nhập đầy đủ email và mật khẩu.');
      return;
    }
    this.errorMessage.set(null);
    this.successMessage.set(null);
    this.submitting.set(true);
    this.session.clear();
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
          this.applyLockout(error);
          this.errorMessage.set(adminErrorMessage(error, 'Thông tin đăng nhập không chính xác.'));
          return of(null);
        }),
      )
      .subscribe((context) => {
        if (!context) {
          return;
        }
        this.remainingAttempts.set(null);
        this.lockedUntil.set(null);
        this.stopCountdown();
        const session = this.session.applyAuthContext(context);
        this.submitting.set(false);
        void this.router.navigateByUrl(this.session.firstRoute(session), { replaceUrl: true });
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

  private applyLockout(error: unknown): void {
    const lockout = adminAuthLockout(error);
    if (!lockout) {
      return;
    }
    this.remainingAttempts.set(lockout.remainingAttempts);
    if (lockout.lockedUntil) {
      const until = Date.parse(lockout.lockedUntil);
      if (!Number.isNaN(until)) {
        this.startCountdown(until);
        return;
      }
    }
    if (lockout.retryAfterSeconds > 0) {
      this.startCountdown(Date.now() + lockout.retryAfterSeconds * 1000);
    }
  }

  private startCountdown(until: number): void {
    this.lockedUntil.set(until);
    this.remainingLockMs.set(Math.max(0, until - Date.now()));
    this.form.disable({ emitEvent: false });
    this.stopCountdown();
    this.countdownTimer = setInterval(() => {
      const left = Math.max(0, until - Date.now());
      this.remainingLockMs.set(left);
      if (left <= 0) {
        this.lockedUntil.set(null);
        this.remainingAttempts.set(null);
        this.form.enable({ emitEvent: false });
        this.stopCountdown();
      }
    }, 1000);
  }

  private stopCountdown(): void {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
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

/**
 * Formats remaining lock time as mm:ss for the login banner.
 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
