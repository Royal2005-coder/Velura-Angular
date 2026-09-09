import { Component, OnDestroy, effect, inject, input, output, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/services/api.service';

export interface AuthOtpResult {
  token?: string;
  user?: Record<string, unknown>;
  otpCode: string;
}

/**
 * Original 6-digit auth OTP dialog used by sign-in, sign-up, and forgot-password.
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
  readonly secondsLeft = signal(300);
  readonly resendCooldown = signal(60);
  readonly errorMessage = signal<string | null>(null);
  readonly verifying = signal(false);
  readonly timerLabel = signal('05:00');
  readonly expired = signal(false);

  private expireTimer: number | null = null;
  private resendTimer: number | null = null;

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
   * Moves backward on backspace when the current cell is empty.
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
   * Spreads a pasted 6-digit code across the original OTP cells.
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
   * Confirms the original 6-digit auth OTP.
   */
  verify(): void {
    const otp = this.digits().join('');
    if (otp.length !== 6) {
      this.errorMessage.set('Vui lòng nhập đủ 6 chữ số.');
      return;
    }
    if (this.expired()) {
      this.errorMessage.set('Mã OTP đã hết hạn. Vui lòng gửi lại.');
      return;
    }
    this.verifying.set(true);
    this.errorMessage.set(null);
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
          this.verifying.set(false);
          this.errorMessage.set(error.message || 'Mã OTP không chính xác.');
        },
      });
  }

  /**
   * Requests a new OTP using the original resend endpoint.
   */
  resend(): void {
    if (this.resendCooldown() > 0) {
      return;
    }
    this.api.post<unknown>('/api/user/auth/otp-send', { identity: this.identity() }).subscribe({
      next: () => this.resetState(),
      error: (error: Error) => this.errorMessage.set(error.message),
    });
  }

  /**
   * Closes the original OTP dialog without verifying.
   */
  cancel(): void {
    this.clearTimers();
    this.cancelled.emit();
  }

  private resetState(): void {
    this.digits.set(['', '', '', '', '', '']);
    this.secondsLeft.set(300);
    this.resendCooldown.set(60);
    this.errorMessage.set(null);
    this.expired.set(false);
    this.timerLabel.set('05:00');
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
        this.errorMessage.set('Mã OTP đã hết hạn. Vui lòng gửi lại.');
        if (this.expireTimer) {
          window.clearInterval(this.expireTimer);
          this.expireTimer = null;
        }
      }
    }, 1000);
    this.resendTimer = window.setInterval(() => {
      const next = this.resendCooldown() - 1;
      this.resendCooldown.set(Math.max(0, next));
      if (next <= 0 && this.resendTimer) {
        window.clearInterval(this.resendTimer);
        this.resendTimer = null;
      }
    }, 1000);
  }

  private clearTimers(): void {
    if (this.expireTimer) {
      window.clearInterval(this.expireTimer);
      this.expireTimer = null;
    }
    if (this.resendTimer) {
      window.clearInterval(this.resendTimer);
      this.resendTimer = null;
    }
  }
}
