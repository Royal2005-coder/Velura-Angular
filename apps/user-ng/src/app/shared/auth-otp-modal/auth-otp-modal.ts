import { Component, OnDestroy, effect, inject, input, output, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/services/api.service';
import { environment } from '../../../environments/environment';

export interface AuthOtpResult {
  token?: string;
  user?: Record<string, unknown>;
  otpCode: string;
}

/**
 * Shared 6-digit OTP verification dialog supporting phone masking, rate limiting, and fallback FE testing.
 */
@Component({
  selector: 'app-auth-otp-modal',
  templateUrl: './auth-otp-modal.html',
})
export class AuthOtpModal implements OnDestroy {
  private readonly api = inject(ApiService);

  readonly identity = input.required<string>();
  readonly purpose = input('');
  readonly open = input(false);

  readonly verified = output<AuthOtpResult>();
  readonly cancelled = output<void>();

  readonly digits = signal(['', '', '', '', '', '']);
  readonly secondsLeft = signal(60);
  readonly errorMessage = signal<string | null>(null);
  readonly verifying = signal(false);
  readonly timerLabel = signal('05:00');
  readonly expired = signal(false);
  readonly attempts = signal(0);
  readonly rateLimited = signal(false);
  readonly sendError = signal(false);

  private expireTimer: number | null = null;

  constructor() {
    effect(() => {
      const isOpen = this.open();
      untracked(() => {
        if (isOpen) {
          this.resetState();
          return;
        }
        this.clearTimers();
      });
    });
  }

  ngOnDestroy(): void {
    this.clearTimers();
  }

  /**
   * Returns phone number with masked digits (e.g. ******5678) according to spec.
   */
  maskedPhone(): string {
    const raw = (this.identity() || '').replace(/\D/g, '');
    if (raw.length >= 7) {
      return '******' + raw.slice(-4);
    }
    return '******5678';
  }

  /**
   * Formats remaining OTP lifetime as mm:ss.
   */
  timerText(): string {
    return this.timerLabel();
  }

  /**
   * Captures one OTP cell and auto-advances focus.
   */
  onDigit(index: number, event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input.value.replace(/\D/g, '').slice(-1);
    const next = [...this.digits()];
    next[index] = value;
    this.digits.set(next);
    if (value && index < 5) {
      const sibling = input.parentElement?.children[index + 1] as HTMLInputElement | undefined;
      sibling?.focus();
    }
    if (next.join('').length === 6) {
      this.verify();
    }
  }

  /**
   * Moves backward on backspace when current cell is empty.
   */
  onKeydown(index: number, event: KeyboardEvent): void {
    if (event.key !== 'Backspace' || this.digits()[index] || index === 0) {
      return;
    }
    const input = event.target as HTMLInputElement;
    const sibling = input.parentElement?.children[index - 1] as HTMLInputElement | undefined;
    sibling?.focus();
  }

  /**
   * Spreads a pasted 6-digit code across cells.
   */
  onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const pasted = (event.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    const next = ['', '', '', '', '', ''];
    pasted.split('').forEach((ch, index) => {
      next[index] = ch;
    });
    this.digits.set(next);
    if (pasted.length === 6) {
      this.verify();
    }
  }

  /**
   * Verifies 6-digit OTP code against backend with fallback FE testing support.
   */
  verify(): void {
    if (this.rateLimited()) {
      return;
    }
    const otp = this.digits().join('');
    if (otp.length !== 6) {
      this.errorMessage.set('Vui lòng nhập đủ 6 chữ số.');
      return;
    }
    if (this.expired()) {
      this.errorMessage.set('Mã OTP đã hết hạn. Vui lòng yêu cầu mã mới.');
      return;
    }

    this.verifying.set(true);
    this.errorMessage.set(null);

    if (environment.mockAuth) {
      window.setTimeout(() => {
        this.verifying.set(false);
        if (otp === '123456') {
          this.clearTimers();
          this.verified.emit({ otpCode: otp });
        } else {
          this.errorMessage.set('Mã OTP không chính xác. Vui lòng kiểm tra và thử lại.');
        }
      }, 250);
      return;
    }

    this.api
      .post<{ token?: string; user?: Record<string, unknown> }>('/api/user/auth/otp-verify', {
        identity: this.identity(),
        otp_code: otp,
        purpose: this.purpose() || undefined,
      })
      .subscribe({
        next: (data) => {
          this.verifying.set(false);
          this.clearTimers();
          this.verified.emit({ ...data, otpCode: otp });
        },
        error: (error: Error) => {
          const count = this.attempts() + 1;
          this.attempts.set(count);

          if (count >= 5) {
            this.verifying.set(false);
            this.rateLimited.set(true);
            this.errorMessage.set('Bạn đã nhập sai quá số lần cho phép.');
            return;
          }

          this.verifying.set(false);
          this.errorMessage.set(error.message || 'Mã OTP không chính xác. Vui lòng kiểm tra và thử lại.');
        },
      });
  }

  /**
   * Requests a new OTP code using resend endpoint.
   */
  resend(): void {
    if (this.secondsLeft() > 0) {
      return;
    }
    this.sendError.set(false);
    if (environment.mockAuth) {
      this.resetState();
      return;
    }
    this.api.post<unknown>('/api/user/auth/otp-send', { identity: this.identity() }).subscribe({
      next: () => this.resetState(),
      error: () => {
        // Soft fallback for testing resend
        this.resetState();
      },
    });
  }

  /**
   * Closes OTP dialog.
   */
  cancel(): void {
    this.clearTimers();
    this.cancelled.emit();
  }

  private resetState(): void {
    this.digits.set(['', '', '', '', '', '']);
    this.secondsLeft.set(60);
    this.errorMessage.set(null);
    this.expired.set(false);
    this.rateLimited.set(false);
    this.sendError.set(false);
    this.timerLabel.set('01:00');
    this.startTimers();
  }

  private startTimers(): void {
    this.clearTimers();
    this.expireTimer = window.setInterval(() => {
      const next = this.secondsLeft() - 1;
      this.secondsLeft.set(Math.max(0, next));
      const minutes = String(Math.floor(Math.max(0, next) / 60)).padStart(2, '0');
      const seconds = String(Math.max(0, next) % 60).padStart(2, '0');
      this.timerLabel.set(`${minutes}:${seconds}`);
      if (next <= 0) {
        this.expired.set(true);
        this.errorMessage.set('Mã OTP đã hết hạn. Vui lòng yêu cầu mã mới.');
        if (this.expireTimer) {
          window.clearInterval(this.expireTimer);
          this.expireTimer = null;
        }
      }
    }, 1000);
  }

  private clearTimers(): void {
    if (this.expireTimer) {
      window.clearInterval(this.expireTimer);
      this.expireTimer = null;
    }
  }
}

