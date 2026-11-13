import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';
import { AdminErpApiService } from '../../core/admin-erp-api.service';
import { adminErrorMessage } from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { useBodyClass } from '../../core/body-class';
import { AuthFrame } from './auth-frame';

const PKCE_STORAGE_KEY = 'velura-admin-erp-oauth-pkce';
const STATE_STORAGE_KEY = 'velura-admin-erp-oauth-state';

interface OAuthErrorInfo {
  readonly message: string;
  readonly hint?: string;
  readonly code: string;
  readonly retryable: boolean;
}

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
 * Exposes actionable error diagnosis badges and one-click retry for internal staff and tech ops.
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
          @if (errorHint()) {
            <p class="callback__hint" style="margin-top: 6px; font-size: 12px; color: var(--erp-muted);">{{ errorHint() }}</p>
          }
          @if (technicalCode()) {
            <div class="callback__diagnostic" style="margin: 10px 0; padding: 6px 10px; background: rgba(0,0,0,0.03); border: 1px solid var(--erp-line, #e2e8f0); border-radius: var(--erp-radius-sm, 6px); font-size: 11px; display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%;">
              <span>Mã kỹ thuật: <code>{{ technicalCode() }}</code></span>
              <button type="button" (click)="copyCode()" style="background: transparent; border: 1px solid var(--erp-line, #cbd5e1); padding: 2px 6px; border-radius: 4px; font-size: 11px; cursor: pointer;">
                {{ copied() ? 'Đã sao chép' : 'Sao chép' }}
              </button>
            </div>
          }
          <div style="display: flex; flex-direction: column; gap: 8px; width: 100%; margin-top: 12px;">
            @if (canRetry()) {
              <button type="button" class="erp-btn erp-btn--primary" (click)="retryGoogle()">Thử lại bằng Google</button>
            }
            <a class="erp-btn erp-btn--secondary" routerLink="/login" style="text-align: center; text-decoration: none;">Quay lại đăng nhập</a>
          </div>
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
  readonly errorHint = signal<string | null>(null);
  readonly technicalCode = signal<string | null>(null);
  readonly canRetry = signal(false);
  readonly copied = signal(false);
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

    // PKCE verifier / state check. Strict match against CSRF.
    if (expectedState && (!state || state !== expectedState)) {
      this.cleanStorage();
      this.fail({
        message: 'Phiên xác thực bảo mật không khớp hoặc bị thiếu. Vui lòng đăng nhập lại.',
        hint: 'Yêu cầu có thể đã bị can thiệp hoặc hết hạn.',
        code: 'STATE_MISMATCH',
        retryable: true,
      });
      return;
    }

    // Direct token flow (implicit grant or OAuth redirect fragment)
    if (accessToken) {
      this.cleanStorage();
      this.session.setToken(accessToken);
      this.api.me().subscribe({
        next: (context) => {
          const session = this.session.applyAuthContext(context);
          void this.router.navigateByUrl(this.session.firstRoute(session));
        },
        error: (error: unknown) =>
          this.fail({
            message: adminErrorMessage(error, 'Không thể xác minh quyền quản trị.'),
            code: 'ADMIN_VERIFICATION_FAILED',
            retryable: true,
          }),
      });
      return;
    }

    // PKCE authorization code exchange
    if (code && verifier) {
      const redirectUri = `${window.location.origin}/auth/callback`;
      this.api.exchangePkce(code, verifier, redirectUri).subscribe({
        next: (payload) => {
          if (!payload.token) {
            this.fail({
              message: 'Phản hồi xác thực thiếu access token.',
              code: 'EMPTY_TOKEN_PAYLOAD',
              retryable: true,
            });
            return;
          }
          this.cleanStorage();
          this.session.setToken(payload.token);
          this.api.me().subscribe({
            next: (context) => {
              const session = this.session.applyAuthContext(context);
              void this.router.navigateByUrl(this.session.firstRoute(session));
            },
            error: (error: unknown) =>
              this.fail({
                message: adminErrorMessage(error, 'Không thể xác minh quyền quản trị.'),
                code: 'ADMIN_VERIFICATION_FAILED',
                retryable: true,
              }),
          });
        },
        error: (error: unknown) =>
          this.fail({
            message: adminErrorMessage(error, 'Xác thực thất bại.'),
            code: 'PKCE_EXCHANGE_FAILED',
            retryable: true,
          }),
      });
      return;
    }

    this.fail({
      message: 'Không tìm thấy mã xác thực hợp lệ trong URL.',
      hint: 'Vui lòng thực hiện đăng nhập lại từ trang Login.',
      code: 'MISSING_AUTH_CODE',
      retryable: true,
    });
  }

  async copyCode(): Promise<void> {
    const code = this.technicalCode();
    if (!code || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(code);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      // Ignore in restricted environments
    }
  }

  async retryGoogle(): Promise<void> {
    try {
      const redirectTo = `${window.location.origin}/auth/callback`;
      const verifier = this.randomVerifier();
      const state = this.randomVerifier();
      const challenge = await this.codeChallenge(verifier);
      sessionStorage.setItem(PKCE_STORAGE_KEY, verifier);
      sessionStorage.setItem(STATE_STORAGE_KEY, state);
      localStorage.setItem(PKCE_STORAGE_KEY, verifier);
      localStorage.setItem(STATE_STORAGE_KEY, state);
      const url =
        `${environment.apiUrl}/api/auth/google` +
        `?redirect_to=${encodeURIComponent(redirectTo)}` +
        `&code_challenge=${encodeURIComponent(challenge)}` +
        `&state=${encodeURIComponent(state)}`;
      window.location.href = url;
    } catch {
      this.errorMessage.set('Không thể kết nối Google. Vui lòng thử lại sau.');
    }
  }

  private cleanStorage(): void {
    sessionStorage.removeItem(PKCE_STORAGE_KEY);
    sessionStorage.removeItem(STATE_STORAGE_KEY);
    localStorage.removeItem(PKCE_STORAGE_KEY);
    localStorage.removeItem(STATE_STORAGE_KEY);
  }

  private fail(err: OAuthErrorInfo | string): void {
    this.failed.set(true);
    this.title.set('Xác thực thất bại');
    this.detail.set('Bạn có thể quay lại trang đăng nhập và thử lại.');
    if (typeof err === 'string') {
      this.errorMessage.set(err);
      this.errorHint.set(null);
      this.technicalCode.set(null);
      this.canRetry.set(false);
    } else {
      this.errorMessage.set(err.message);
      this.errorHint.set(err.hint || null);
      this.technicalCode.set(err.code);
      this.canRetry.set(err.retryable);
    }
  }

  private describeProviderError(description: string, code: string): OAuthErrorInfo {
    const text = `${code} ${description}`.toLowerCase();

    if (
      text.includes('redirect_uri_not_allowed') ||
      text.includes('redirect_to is not allowed') ||
      text.includes('url not allowed')
    ) {
      return {
        message: 'Địa chỉ chuyển hướng xác thực chưa được cấp phép trong hệ thống.',
        hint: 'Vui lòng kiểm tra Redirect URLs trên Supabase Console hoặc liên hệ quản trị viên.',
        code: code || 'REDIRECT_URI_NOT_ALLOWED',
        retryable: false,
      };
    }

    if (text.includes('redirect_uri_mismatch')) {
      return {
        message: 'URL chuyển hướng OAuth không khớp cấu hình Google Cloud. Vui lòng kiểm tra lại Authorized redirect URIs.',
        hint: 'Authorized redirect URIs trong Google Cloud Console chưa khớp URL callback của Supabase.',
        code: code || 'REDIRECT_URI_MISMATCH',
        retryable: false,
      };
    }

    if (text.includes('provider is not enabled') || text.includes('unsupported provider')) {
      return {
        message: 'Đăng nhập Google SSO chưa được bật trên hệ thống. Vui lòng đăng nhập bằng tài khoản quản trị.',
        hint: 'Kích hoạt Google Provider trên Supabase Cloud Dashboard.',
        code: code || 'PROVIDER_DISABLED',
        retryable: false,
      };
    }

    if (text.includes('access_denied') || text.includes('denied access')) {
      return {
        message: 'Bạn đã huỷ đăng nhập Google. Vui lòng thử lại nếu muốn tiếp tục.',
        hint: 'Bấm nút Thử lại bằng Google bên dưới để đăng nhập lại.',
        code: code || 'ACCESS_DENIED',
        retryable: true,
      };
    }

    if (text.includes('invalid_client')) {
      return {
        message: 'Thông tin xác thực Google Client không hợp lệ. Vui lòng kiểm tra lại Client ID hoặc Secret trong Supabase.',
        hint: 'Client ID hoặc Secret cấu hình trên Supabase không chính xác.',
        code: code || 'INVALID_CLIENT',
        retryable: false,
      };
    }

    if (text.includes('database error') || text.includes('server_error')) {
      return {
        message: 'Hệ thống xác thực Supabase gặp sự cố khi lưu trữ thông tin tài khoản.',
        hint: 'Vui lòng thử lại sau vài phút hoặc đăng nhập bằng tài khoản email quản trị.',
        code: code || 'DATABASE_SERVER_ERROR',
        retryable: true,
      };
    }

    return {
      message: 'Không thể xác thực với Google. Vui lòng đăng nhập bằng email và mật khẩu quản trị.',
      hint: description || 'Đã xảy ra lỗi không xác định từ nhà cung cấp OAuth.',
      code: code || 'UNKNOWN_OAUTH_ERROR',
      retryable: true,
    };
  }

  private randomVerifier(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes, (b) => ('0' + b.toString(16)).slice(-2)).join('');
  }

  private async codeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}
