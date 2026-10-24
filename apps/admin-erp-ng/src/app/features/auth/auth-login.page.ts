import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { catchError, of, switchMap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AdminErpApiService } from '../../core/admin-erp-api.service';
import { adminAuthLockout, adminErrorMessage } from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { useBodyClass } from '../../core/body-class';
import { AuthFrame } from './auth-frame';

const PKCE_STORAGE_KEY = 'velura-admin-erp-oauth-pkce';

/**
 * Admin sign-in through the existing `/api/auth/signin` lockout flow.
 */
@Component({
  selector: 'app-auth-login-page',
  imports: [ReactiveFormsModule, RouterLink, AuthFrame],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-auth-frame>
      <header class="auth-head">
        <span>Đăng nhập quản trị</span>
        <h2>Chào mừng trở lại</h2>
        <p>Dùng tài khoản đã được cấp quyền vận hành Velura.</p>
      </header>

      @if (errorMessage()) {
        <div class="auth-alert auth-alert--error" role="alert">{{ errorMessage() }}</div>
      }
      @if (successMessage()) {
        <div class="auth-alert auth-alert--success" role="status">{{ successMessage() }}</div>
      }
      @if (isLocked()) {
        <div class="auth-alert auth-alert--warning" role="status">
          Tài khoản tạm khóa 15 phút. Thử lại sau <strong>{{ lockCountdown() }}</strong>.
        </div>
      } @else if (remainingAttempts() !== null) {
        <p class="auth-attempts">Còn {{ remainingAttempts() }} lần thử trước khi tài khoản bị khóa.</p>
      }

      <button class="auth-google" type="button" (click)="startGoogle()" [disabled]="isLocked() || submitting()">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
        </svg>
        Đăng nhập bằng Google
      </button>
      <p class="auth-google-note">Đăng nhập an toàn qua API Velura</p>
      <div class="auth-divider"><span>hoặc</span></div>

      <form class="auth-form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <label class="erp-field">
          <span>Email</span>
          <input class="erp-input" type="email" formControlName="email" placeholder="email@velura.vn" autocomplete="email" />
        </label>
        <label class="erp-field">
          <span>Mật khẩu</span>
          <input class="erp-input" type="password" formControlName="password" placeholder="Nhập mật khẩu" autocomplete="current-password" />
        </label>
        <button class="erp-btn erp-btn--primary auth-submit" type="submit" [disabled]="submitting() || isLocked()">
          {{ submitting() ? 'Đang đăng nhập…' : 'Đăng nhập' }}
        </button>
      </form>

      <div class="auth-links">
        <button class="auth-link" type="button" (click)="forgot($event)">Quên mật khẩu?</button>
        <a class="auth-link" routerLink="/register">Cần quyền truy cập?</a>
      </div>
    </app-auth-frame>
  `,
  styles: [
    `
      .auth-head {
        display: grid;
        gap: 6px;
        margin-bottom: 22px;
      }
      .auth-head span {
        color: var(--erp-accent-strong);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .auth-head h2 {
        font-family: var(--erp-display);
        font-size: 28px;
        font-weight: 600;
        line-height: 1.1;
        color: var(--erp-ink);
      }
      .auth-head p,
      .auth-google-note,
      .auth-attempts {
        color: var(--erp-muted);
        font-size: 12px;
      }
      .auth-alert {
        margin-bottom: 14px;
        padding: 10px 12px;
        border-radius: var(--erp-radius-sm);
        font-size: 12px;
      }
      .auth-alert--error {
        background: var(--erp-danger-soft);
        color: var(--erp-danger);
      }
      .auth-alert--warning {
        background: var(--erp-warning-soft);
        color: var(--erp-warning);
      }
      .auth-alert--success {
        background: var(--erp-success-soft);
        color: var(--erp-success);
      }
      .auth-google {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        width: 100%;
        min-height: 40px;
        border: 1px solid var(--erp-line-strong);
        border-radius: var(--erp-radius-sm);
        background: var(--erp-surface);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }
      .auth-google:hover:not(:disabled) {
        background: var(--erp-surface-muted);
      }
      .auth-google-note {
        margin-top: 7px;
        text-align: center;
        font-size: 10px;
      }
      .auth-divider {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 18px 0;
        color: var(--erp-soft);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      .auth-divider::before,
      .auth-divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: var(--erp-line);
      }
      .auth-form {
        display: grid;
        gap: 14px;
      }
      .auth-submit {
        min-height: 42px;
        margin-top: 4px;
      }
      .auth-links {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-top: 18px;
      }
      .auth-link {
        border: 0;
        background: transparent;
        color: var(--erp-accent-strong);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .auth-link:hover {
        text-decoration: underline;
      }
      .auth-attempts {
        margin-bottom: 12px;
      }
    `,
  ],
  host: { class: 'erp-auth-page' },
})
export class AuthLoginPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);
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
    useBodyClass('erp-auth');
    this.session.clear();
    this.destroyRef.onDestroy(() => this.stopCountdown());
  }

  /**
   * Signs in through the API so the existing AUTH-02 lockout rules still run.
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
   * Starts the existing Google PKCE redirect with an ERP-specific verifier key.
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
   * Sends the existing password-reset email without revealing account existence.
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
 * Formats remaining lock time as mm:ss.
 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
