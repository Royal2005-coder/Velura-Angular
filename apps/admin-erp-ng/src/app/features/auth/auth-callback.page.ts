import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AdminErpApiService } from '../../core/admin-erp-api.service';
import { adminErrorMessage } from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { useBodyClass } from '../../core/body-class';
import { AuthFrame } from './auth-frame';

const PKCE_STORAGE_KEY = 'velura-admin-erp-oauth-pkce';
const STATE_STORAGE_KEY = 'velura-admin-erp-oauth-state';

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

/**
 * Exchanges the Google PKCE code or applies direct access token, and hydrates the ERP session.
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
    const params = extractAuthCallbackParams();
    const providerError = params.get('error_description') || params.get('error');
    if (providerError) {
      this.fail(this.describeProviderError(providerError, params.get('error') || ''));
      return;
    }

    const accessToken = params.get('access_token');
    const code = params.get('code');
    const verifier = sessionStorage.getItem(PKCE_STORAGE_KEY) || localStorage.getItem(PKCE_STORAGE_KEY);
    const state = params.get('state');
    const expectedState = sessionStorage.getItem(STATE_STORAGE_KEY) || localStorage.getItem(STATE_STORAGE_KEY);

    // PKCE verifier / state check. If an echoed state is returned, it must match.
    if (state && expectedState && state !== expectedState) {
      sessionStorage.removeItem(PKCE_STORAGE_KEY);
      sessionStorage.removeItem(STATE_STORAGE_KEY);
      localStorage.removeItem(PKCE_STORAGE_KEY);
      localStorage.removeItem(STATE_STORAGE_KEY);
      this.fail('Phiên xác thực không khớp. Vui lòng đăng nhập lại.');
      return;
    }

    // Direct token flow (implicit grant or OAuth redirect fragment)
    if (accessToken) {
      sessionStorage.removeItem(PKCE_STORAGE_KEY);
      sessionStorage.removeItem(STATE_STORAGE_KEY);
      localStorage.removeItem(PKCE_STORAGE_KEY);
      localStorage.removeItem(STATE_STORAGE_KEY);
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
            this.fail('Phản hồi xác thực thiếu access token.');
            return;
          }
          sessionStorage.removeItem(PKCE_STORAGE_KEY);
          sessionStorage.removeItem(STATE_STORAGE_KEY);
          localStorage.removeItem(PKCE_STORAGE_KEY);
          localStorage.removeItem(STATE_STORAGE_KEY);
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
      return;
    }

    this.fail('Không tìm thấy mã xác thực hợp lệ trong URL.');
  }

  private fail(message: string): void {
    this.failed.set(true);
    this.title.set('Xác thực thất bại');
    this.detail.set('Bạn có thể quay lại trang đăng nhập và thử lại.');
    this.errorMessage.set(message);
  }

  private describeProviderError(description: string, code: string): string {
    const text = `${code} ${description}`.toLowerCase();
    if (text.includes('provider is not enabled') || text.includes('unsupported provider')) {
      return 'Đăng nhập Google SSO chưa được bật trên hệ thống. Vui lòng đăng nhập bằng tài khoản quản trị.';
    }
    if (text.includes('access_denied') || text.includes('denied access')) {
      return 'Bạn đã huỷ đăng nhập Google. Vui lòng thử lại nếu muốn tiếp tục.';
    }
    if (text.includes('redirect_uri_mismatch')) {
      return 'URL chuyển hướng OAuth không khớp cấu hình Google Cloud. Vui lòng kiểm tra lại Authorized redirect URIs.';
    }
    if (text.includes('invalid_client')) {
      return 'Thông tin xác thực Google Client không hợp lệ. Vui lòng kiểm tra lại Client ID hoặc Secret trong Supabase.';
    }
    return 'Không thể xác thực với Google. Vui lòng đăng nhập bằng email và mật khẩu quản trị.';
  }
}
