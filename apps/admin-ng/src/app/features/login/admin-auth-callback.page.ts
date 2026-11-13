import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AdminApiService } from '../../core/admin-api.service';
import { adminErrorMessage } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';
import { useBodyClass } from '../../core/body-class';

const PKCE_STORAGE_KEY = 'velura-oauth-pkce-code-verifier';

function extractAuthCallbackParams(): Map<string, string> {
  const map = new Map<string, string>();
  const search = window.location.search.replace(/^\?/, '');
  if (search) {
    new URLSearchParams(search).forEach((v, k) => map.set(k, v));
  }
  const hash = window.location.hash.replace(/^#/, '');
  if (hash) {
    const hashQuery = hash.includes('?') ? hash.split('?')[1] : hash;
    new URLSearchParams(hashQuery).forEach((v, k) => {
      if (!map.has(k)) map.set(k, v);
    });
  }
  return map;
}

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
    const params = extractAuthCallbackParams();
    const providerError = params.get('error_description') || params.get('error');
    if (providerError) {
      this.fail(this.describeProviderError(providerError, params.get('error') || ''));
      return;
    }

    const accessToken = params.get('access_token');
    const code = params.get('code');
    const verifier = localStorage.getItem(PKCE_STORAGE_KEY);

    // Direct token flow (implicit grant or hash fragment)
    if (accessToken) {
      localStorage.removeItem(PKCE_STORAGE_KEY);
      this.session.setToken(accessToken);
      this.api.me().subscribe({
        next: (context) => {
          const session = this.session.applyAuthContext(context);
          void this.router.navigateByUrl(this.session.firstRoute(session));
        },
        error: (error: unknown) => this.fail(adminErrorMessage(error, 'Không thể xác minh quyền quản trị.')),
      });
      return;
    }

    // PKCE authorization code exchange
    if (code && verifier) {
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
      return;
    }

    this.fail('Không tìm thấy mã xác thực trong URL.');
  }

  private fail(message: string): void {
    this.failed.set(true);
    this.title.set('Xác thực thất bại');
    this.detail.set('');
    this.errorMessage.set(message);
  }

  private describeProviderError(description: string, code: string): string {
    const text = `${code} ${description}`.toLowerCase();
    if (text.includes('provider is not enabled') || text.includes('unsupported provider')) {
      return 'Đăng nhập Google SSO chưa được bật trên hệ thống.';
    }
    if (text.includes('access_denied') || text.includes('denied access')) {
      return 'Bạn đã huỷ đăng nhập Google.';
    }
    return 'Không thể xác thực với Google.';
  }
}
