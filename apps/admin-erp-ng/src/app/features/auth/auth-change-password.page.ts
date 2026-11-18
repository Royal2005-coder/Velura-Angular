import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AdminErpApiService } from '../../core/admin-erp-api.service';
import { adminErrorMessage } from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { useBodyClass } from '../../core/body-class';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AuthFrame } from './auth-frame';

/**
 * Changes the signed-in password through the existing API.
 */
@Component({
  selector: 'app-auth-change-password-page',
  imports: [ReactiveFormsModule, RouterLink, AuthFrame, AdminErpIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-auth-frame>
      <header class="cp-head">
        <span>Bảo mật tài khoản</span>
        <h2>Đặt lại mật khẩu</h2>
        <p>Mật khẩu mới cần tối thiểu 12 ký tự.</p>
      </header>

      @if (errorMessage()) {
        <div class="cp-error" role="alert">{{ errorMessage() }}</div>
      }

      <form class="cp-form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <div class="erp-field">
          <label for="cp-current">Mật khẩu hiện tại</label>
          <div class="erp-secret-wrap">
            <input id="cp-current" class="erp-input" [type]="showPasswords() ? 'text' : 'password'" formControlName="current" autocomplete="current-password" />
            <button type="button" class="erp-secret-toggle" [attr.aria-label]="showPasswords() ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'" (click)="togglePasswords()">
              <app-erp-icon [name]="showPasswords() ? 'eye-off' : 'eye'" [size]="'16'" />
            </button>
          </div>
        </div>
        <div class="erp-field">
          <label for="cp-next">Mật khẩu mới</label>
          <div class="erp-secret-wrap">
            <input id="cp-next" class="erp-input" [type]="showPasswords() ? 'text' : 'password'" formControlName="next" placeholder="Ít nhất 12 ký tự" autocomplete="new-password" />
          </div>
        </div>
        <div class="erp-field">
          <label for="cp-confirm">Xác nhận mật khẩu mới</label>
          <div class="erp-secret-wrap">
            <input id="cp-confirm" class="erp-input" [type]="showPasswords() ? 'text' : 'password'" formControlName="confirm" autocomplete="new-password" />
          </div>
        </div>
        <button class="erp-btn erp-btn--primary cp-submit" type="submit" [disabled]="saving()">
          {{ saving() ? 'Đang cập nhật…' : 'Đổi mật khẩu' }}
        </button>
      </form>

      <a class="cp-back" [routerLink]="backRoute()">Quay lại workspace</a>
    </app-auth-frame>
  `,
  styles: [
    `
      .cp-head {
        display: grid;
        gap: 6px;
        margin-bottom: 20px;
      }
      .cp-head span {
        color: var(--erp-accent);
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .cp-head h2 {
        font-family: var(--erp-display);
        font-size: 24px;
        font-weight: 600;
        color: var(--erp-ink);
      }
      .cp-head p {
        color: var(--erp-muted);
        font-size: 13px;
      }
      .cp-error {
        margin-bottom: 14px;
        padding: 10px 12px;
        border-radius: var(--erp-radius-sm);
        background: var(--erp-danger-soft);
        color: var(--erp-danger);
        font-size: 12px;
      }
      .cp-form {
        display: grid;
        gap: 14px;
      }
      .cp-submit {
        min-height: 42px;
        margin-top: 4px;
      }
      .cp-back {
        display: inline-block;
        margin-top: 18px;
        color: var(--erp-accent-strong);
        font-size: 12px;
        font-weight: 600;
      }
      .cp-back:hover {
        text-decoration: underline;
      }
    `,
  ],
})
export class AuthChangePasswordPage {
  private readonly session = inject(AdminErpSessionService);
  private readonly api = inject(AdminErpApiService);
  private readonly router = inject(Router);

  readonly errorMessage = signal<string | null>(null);
  readonly saving = signal(false);
  readonly showPasswords = signal(false);

  /** Toggles password visibility across current/new/confirm inputs. */
  togglePasswords(): void {
    this.showPasswords.update((v) => !v);
  }

  readonly form = new FormGroup({
    current: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    next: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(12)] }),
    confirm: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  constructor() {
    useBodyClass('erp-auth');
  }

  /**
   * Returns members to welcome and admins to their first workspace.
   */
  backRoute(): string {
    return this.session.isAdmin() ? this.session.firstRoute() : '/welcome';
  }

  /**
   * Validates and submits the password change.
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
