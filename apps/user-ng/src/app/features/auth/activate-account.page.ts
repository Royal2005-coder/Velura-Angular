import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';

/** Hợp đồng frontend nhận sau khi token Guest được đổi thành phiên Member. */
interface ActivateAccountResponse {
  success?: boolean;
  message?: string;
  token?: string;
  user?: Record<string, unknown>;
}

@Component({
  selector: 'app-activate-account-page',
  imports: [ReactiveFormsModule, RouterLink],
  host: { class: 'velura-auth-page' },
  templateUrl: './activate-account.page.html',
})
export class ActivateAccountPage {
  private readonly forms = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly errorMessage = signal<string | null>(null);
  readonly successMessage = signal<string | null>(null);
  readonly submitting = signal(false);
  readonly showPassword = signal(false);
  readonly showConfirm = signal(false);
  readonly form = this.forms.nonNullable.group({
    password: ['', [
      Validators.required,
      Validators.minLength(8),
      Validators.pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d\W]).+$/),
    ]],
    password_confirm: ['', Validators.required],
  });

  /** Kích hoạt tài khoản Guest bằng token URL rồi lưu phiên Member đã xác thực. */
  submit(): void {
    this.errorMessage.set(null);
    const token = this.route.snapshot.queryParamMap.get('token') || '';
    const password = this.form.controls.password.value;
    if (!token) {
      this.errorMessage.set('Liên kết kích hoạt không hợp lệ hoặc đã thiếu token.');
      return;
    }
    if (this.form.invalid) {
      this.errorMessage.set('Mật khẩu phải có ít nhất 8 ký tự, gồm chữ hoa, chữ thường và số hoặc ký tự đặc biệt.');
      return;
    }
    if (password !== this.form.controls.password_confirm.value) {
      this.errorMessage.set('Mật khẩu xác nhận không khớp.');
      return;
    }

    this.submitting.set(true);
    this.api.post<ActivateAccountResponse>('/api/user/auth/activate', { token, password }).subscribe({
      next: (response) => {
        this.submitting.set(false);
        if (!response.success || !response.token || !response.user) {
          this.errorMessage.set(response.message || 'Không thể kích hoạt tài khoản.');
          return;
        }
        this.auth.applySession(response.token, response.user);
        this.successMessage.set('Kích hoạt tài khoản thành công.');
        window.setTimeout(() => void this.router.navigateByUrl('/account/orders'), 800);
      },
      error: (error: Error) => {
        this.submitting.set(false);
        this.errorMessage.set(error.message || 'Liên kết kích hoạt không hợp lệ hoặc đã hết hạn.');
      },
    });
  }
}
