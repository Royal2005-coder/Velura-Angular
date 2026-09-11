import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { useBodyClass } from '../../core/body-class';
import { AdminApiService } from '../../core/admin-api.service';
import { adminErrorMessage } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';

@Component({
  selector: 'app-admin-change-password-page',
  imports: [ReactiveFormsModule, RouterLink],
  host: { class: 'page-auth' },
  template: `
    <main class="auth-card" role="main" aria-label="Đổi mật khẩu">
      <div class="auth-card__brand">
        <img src="/assets/images/logo.png" alt="Velura" />
        <h1>Đặt lại mật khẩu</h1>
        <p>Nhập thông tin để cập nhật mật khẩu mới</p>
      </div>
      <div class="auth-notice" role="status">
        Bạn đang đăng nhập bằng mật khẩu dùng một lần (OTP) hoặc đang yêu cầu đổi mật khẩu. Hãy đổi mật khẩu ngay để bảo vệ tài khoản.
      </div>
      @if (errorMessage()) {
        <div class="auth-error is-visible" role="alert">{{ errorMessage() }}</div>
      }
      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <div class="auth-field">
          <label for="cp-current">Mật khẩu hiện tại <span class="required">*</span></label>
          <input id="cp-current" type="password" formControlName="current" autocomplete="current-password" />
        </div>
        <div class="auth-field">
          <label for="cp-new">Mật khẩu mới <span class="required">*</span></label>
          <input id="cp-new" type="password" formControlName="next" placeholder="Ít nhất 12 ký tự" autocomplete="new-password" />
        </div>
        <div class="auth-field">
          <label for="cp-confirm">Xác nhận mật khẩu mới <span class="required">*</span></label>
          <input id="cp-confirm" type="password" formControlName="confirm" autocomplete="new-password" />
        </div>
        <button class="auth-btn auth-btn--primary auth-btn--spaced" type="submit" [disabled]="saving()">Đổi mật khẩu</button>
      </form>
      <div class="auth-footer">
        <a class="auth-btn auth-btn--skip" [routerLink]="backRoute()">Quay lại</a>
      </div>
    </main>
  `,
})
export class AdminChangePasswordPage {
  private readonly session = inject(AdminSessionService);
  private readonly api = inject(AdminApiService);
  private readonly router = inject(Router);
  readonly errorMessage = signal<string | null>(null);
  readonly saving = signal(false);

  readonly form = new FormGroup({
    current: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    next: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(12)] }),
    confirm: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  constructor() {
    useBodyClass('page-auth');
  }

  /**
   * Returns to welcome for members or dashboard for admins.
   */
  backRoute(): string {
    return this.session.isAdmin() ? '/dashboard' : '/welcome';
  }

  /**
   * Validates then changes the signed-in password through `/api/auth/change-password`.
   */
  submit(): void {
    if (this.form.invalid || this.form.controls.next.value !== this.form.controls.confirm.value) {
      this.errorMessage.set('Mật khẩu mới chưa khớp hoặc chưa đủ 12 ký tự.');
      return;
    }
    this.saving.set(true);
    this.errorMessage.set(null);
    this.api.changePassword(this.form.controls.current.value, this.form.controls.next.value).subscribe({
      next: () => {
        this.saving.set(false);
        void this.router.navigateByUrl(this.backRoute());
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.errorMessage.set(adminErrorMessage(error, 'Không đổi được mật khẩu.'));
      },
    });
  }
}
