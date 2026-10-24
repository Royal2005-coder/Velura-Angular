import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AdminErpApiService } from '../../core/admin-erp-api.service';
import { adminErrorMessage } from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { useBodyClass } from '../../core/body-class';
import { AuthFrame } from './auth-frame';

const PKCE_STORAGE_KEY = 'velura-admin-erp-oauth-pkce';

/**
 * Exchanges the Google PKCE code and hydrates the ERP session.
 */
@Component({
  selector: 'app-auth-callback-page',
  imports: [RouterLink, AuthFrame],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-auth-frame>
      <div class="callback" role="status" aria-live="polite">
        @if (!failed()) {
          <span class="callback__spinner" aria-hidden="true"></span>
        }
        <h2>{{ title() }}</h2>
        <p>{{ detail() }}</p>
        @if (errorMessage()) {
          <div class="callback__error" role="alert">{{ errorMessage() }}</div>
          <a class="erp-btn erp-btn--primary" routerLink="/login">Quay lại đăng nhập</a>
        }
      </div>
    </app-auth-frame>
  `,
  styles: [
    `
      .callback {
        display: grid;
        justify-items: center;
        gap: 12px;
        padding: 20px 0;
        text-align: center;
      }
      .callback__spinner {
        width: 34px;
        height: 34px;
        border: 3px solid var(--erp-accent-soft);
        border-top-color: var(--erp-accent);
        border-radius: 50%;
        animation: spin 800ms linear infinite;
      }
      h2 {
        font-family: var(--erp-display);
        font-size: 24px;
        color: var(--erp-ink);
      }
      p {
        color: var(--erp-muted);
        font-size: 13px;
      }
      .callback__error {
        width: 100%;
        padding: 10px 12px;
        border-radius: var(--erp-radius-sm);
        background: var(--erp-danger-soft);
        color: var(--erp-danger);
        font-size: 12px;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class AuthCallbackPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);
  private readonly router = inject(Router);

  readonly title = signal('Đang xác thực với Velura…');
  readonly detail = signal('Hệ thống đang kiểm tra danh tính và quyền truy cập.');
  readonly errorMessage = signal<string | null>(null);
  readonly failed = signal(false);

  constructor() {
    useBodyClass('erp-auth');
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
          this.fail('Phản hồi xác thực thiếu access token.');
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
      error: (error: unknown) => this.fail(adminErrorMessage(error, 'Xác thực thất bại.')),
    });
  }

  private fail(message: string): void {
    this.failed.set(true);
    this.title.set('Xác thực thất bại');
    this.detail.set('Bạn có thể quay lại trang đăng nhập và thử lại.');
    this.errorMessage.set(message);
  }
}
