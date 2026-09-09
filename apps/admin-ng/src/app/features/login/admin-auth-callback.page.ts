import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AdminApiService } from '../../core/admin-api.service';
import { adminErrorMessage } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';
import { useBodyClass } from '../../core/body-class';

const PKCE_STORAGE_KEY = 'velura-oauth-pkce-code-verifier';

@Component({
  selector: 'app-admin-auth-callback-page',
  imports: [RouterLink],
  host: { class: 'page-auth' },
  template: `
    <main class="auth-card verification-card">
      @if (!failed()) {
        <div class="verification-spinner"></div>
      }
      <h1>{{ title() }}</h1>
      <p class="verification-sub">{{ detail() }}</p>
      @if (errorMessage()) {
        <div class="verification-error is-visible" role="alert">{{ errorMessage() }}</div>
        <a class="verification-btn" routerLink="/login">Quay lại đăng nhập</a>
      }
    </main>
  `,
})
export class AdminAuthCallbackPage {
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionService);
  private readonly router = inject(Router);

  readonly title = signal('Đang xác thực với Supabase...');
  readonly detail = signal('Hệ thống đang kiểm tra danh tính và quyền truy cập.');
  readonly errorMessage = signal<string | null>(null);
  readonly failed = signal(false);

  constructor() {
    useBodyClass('page-auth');
    const code = new URL(window.location.href).searchParams.get('code');
    const verifier = localStorage.getItem(PKCE_STORAGE_KEY);
    if (!code || !verifier) {
      this.fail('Không tìm thấy mã xác thực trong URL.');
      return;
    }
    const redirectUri = `${window.location.origin}/auth/callback`;
    this.api.exchangePkce(code, verifier, redirectUri).subscribe({
      next: (payload) => {
        if (!payload.token) {
          this.fail('Response missing access_token');
          return;
        }
        localStorage.removeItem(PKCE_STORAGE_KEY);
        this.session.setToken(payload.token);
        this.api.me().subscribe({
          next: (context) => {
            const session = this.session.applyAuthContext(context);
            void this.router.navigateByUrl(this.session.firstRoute(session));
          },
          error: (error: unknown) => this.fail(adminErrorMessage(error, 'Không thể xác minh quyền quản trị.')),
        });
      },
      error: (error: unknown) => this.fail(adminErrorMessage(error, 'Xác thực thất bại')),
    });
  }

  private fail(message: string): void {
    this.failed.set(true);
    this.title.set('Xác thực thất bại');
    this.detail.set('');
    this.errorMessage.set(message);
  }
}
