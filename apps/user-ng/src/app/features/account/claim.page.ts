import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { showToast } from '../../core/utils/toast';

@Component({
  selector: 'app-claim-account-page',
  host: { style: 'display:block' },
  template: `
    <main class="checkout-page">
      <div class="container" style="max-width:480px;padding:48px 16px">
        <h1 class="page-title">Tạo tài khoản thành viên</h1>
        <p>Số điện thoại đã được xác thực qua SMS. Đặt mật khẩu để nhận ưu đãi và xem đơn hàng trong tài khoản.</p>
        <form (submit)="$event.preventDefault(); submit()">
          <label>Mật khẩu
            <input type="password" [value]="password()" (input)="password.set(inputValue($event))" autocomplete="new-password" />
          </label>
          <label>Nhập lại mật khẩu
            <input type="password" [value]="confirm()" (input)="confirm.set(inputValue($event))" autocomplete="new-password" />
          </label>
          @if (error()) { <p class="field__error">{{ error() }}</p> }
          <button class="btn btn--primary btn--full" type="submit" [disabled]="busy()">
            {{ busy() ? 'Đang lưu...' : 'Hoàn tất đăng ký' }}
          </button>
        </form>
      </div>
    </main>
  `,
})
export class ClaimAccountPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  readonly password = signal('');
  readonly confirm = signal('');
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  submit(): void {
    const token = this.route.snapshot.queryParamMap.get('token') || '';
    if (!token) {
      this.error.set('Thiếu liên kết SMS.');
      return;
    }
    if (this.password() !== this.confirm()) {
      this.error.set('Mật khẩu nhập lại không khớp.');
      return;
    }
    this.busy.set(true);
    this.api
      .post<{ token?: string; user?: Record<string, unknown>; message?: string }>('/api/user/auth/claim-password', {
        token,
        password: this.password(),
        password_confirm: this.confirm(),
      })
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.auth.applySession(res.token, res.user);
          showToast(res.message || 'Đã tạo tài khoản thành viên.');
          void this.router.navigateByUrl('/account/orders');
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.error.set(err.message || 'Không tạo được tài khoản');
        },
      });
  }
}
