import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { WishlistStore } from '../../core/services/wishlist.store';

const PKCE_STORAGE_KEY = 'velura-user-oauth-pkce-code-verifier';
const STATE_STORAGE_KEY = 'velura-user-oauth-state';

interface OAuthErrorInfo {
  readonly message: string;
  readonly hint?: string;
  readonly code: string;
  readonly retryable: boolean;
}

function extractCallbackParams(): Map<string, string> {
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
 * Completes storefront Google PKCE or token callback:
 * exchanges the auth code or applies the direct access token, then mints a Velura member session.
 * Provides transparent error diagnostics and one-click retry for shoppers and support.
 */
@Component({
  selector: 'app-auth-callback-page',
  imports: [RouterLink],
  host: { class: 'velura-auth-page' },
  template: `
    <main class="velura-auth-page" aria-label="Xác thực Google">
      <div class="login-page">
        <section class="login-container">
          <h1>{{ title() }}</h1>
          <p>{{ detail() }}</p>
          @if (errorMessage()) {
            <div class="field__error" style="display: block;" role="alert">{{ errorMessage() }}</div>
            @if (errorHint()) {
              <p class="auth-hint" style="margin-top: 8px; font-size: 13px; color: #6b7280; line-height: 1.5;">{{ errorHint() }}</p>
            }
            @if (technicalCode()) {
              <div class="auth-diagnostic" style="margin: 12px 0; padding: 8px 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 12px; color: #475569; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <span>Mã tra cứu: <code>{{ technicalCode() }}</code></span>
                <button type="button" (click)="copyCode()" style="background: transparent; border: 1px solid #cbd5e1; padding: 2px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;">
                  {{ copied() ? 'Đã sao chép' : 'Sao chép' }}
                </button>
              </div>
            }
            <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 16px;">
              @if (canRetry()) {
                <button type="button" class="btn-login" (click)="retryGoogle()">Thử lại bằng Google</button>
              }
              <a class="btn-login btn-login--secondary" routerLink="/auth/signin" style="text-align: center; text-decoration: none;">Quay lại đăng nhập</a>
            </div>
          }
        </section>
      </div>
    </main>
  `,
})
export class AuthCallbackPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly wishlist = inject(WishlistStore);
  private readonly router = inject(Router);

  readonly title = signal('Đang xác thực với Google...');
  readonly detail = signal('Hệ thống đang kiểm tra danh tính thành viên.');
  readonly errorMessage = signal<string | null>(null);
  readonly errorHint = signal<string | null>(null);
  readonly technicalCode = signal<string | null>(null);
  readonly canRetry = signal(false);
  readonly copied = signal(false);

  constructor() {
    const params = extractCallbackParams();
    // GoTrue reports a rejected provider or consent screen as ?error=...&error_description=...
    // (or in hash fragment #error=...&error_description=...). Surface that reason instead of a generic "no code" message.
    const providerError = params.get('error_description') || params.get('error');
    if (providerError) {
      const errInfo = this.describeProviderError(providerError, params.get('error') || '');
      this.fail(errInfo);
      return;
    }

    const accessToken = params.get('access_token');
    const code = params.get('code');
    const verifier = localStorage.getItem(PKCE_STORAGE_KEY);
    const storedState = localStorage.getItem(STATE_STORAGE_KEY);
    const returnedState = params.get('state');

    // Protect against Login CSRF: if a state challenge was dispatched, returned state must exist and match byte-for-byte.
    if (storedState && (!returnedState || returnedState !== storedState)) {
      localStorage.removeItem(PKCE_STORAGE_KEY);
      localStorage.removeItem(STATE_STORAGE_KEY);
      this.fail({
        message: 'Mã định danh bảo mật (state) không khớp hoặc bị thiếu.',
        hint: 'Yêu cầu đăng nhập có thể đã bị can thiệp hoặc phiên làm việc đã hết hạn.',
        code: 'STATE_MISMATCH',
        retryable: true,
      });
      return;
    }

    // Direct token returned in hash (e.g. Implicit grant or OAuth redirect fragment)
    if (accessToken) {
      localStorage.removeItem(PKCE_STORAGE_KEY);
      localStorage.removeItem(STATE_STORAGE_KEY);
      this.api
        .post<{ token?: string; user?: Record<string, unknown> }>('/api/user/auth/social-login', {
          token: accessToken,
        })
        .subscribe({
          next: (session) => {
            this.auth.applySession(session.token, session.user);
            this.wishlist.refresh();
            void this.router.navigateByUrl('/');
          },
          error: (error: Error) =>
            this.fail({
              message: error.message || 'Không thể tạo phiên thành viên.',
              code: 'SESSION_MINT_FAILED',
              retryable: true,
            }),
        });
      return;
    }

    // PKCE authorization code exchange
    if (code && verifier) {
      const redirectUri = `${window.location.origin}/auth/callback`;
      this.api
        .post<{ token?: string }>('/api/auth/pkce', {
          auth_code: code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        })
        .subscribe({
          next: (payload) => {
            if (!payload.token) {
              this.fail({
                message: 'Không nhận được phiên Google từ máy chủ.',
                code: 'EMPTY_TOKEN_PAYLOAD',
                retryable: true,
              });
              return;
            }
            localStorage.removeItem(PKCE_STORAGE_KEY);
            localStorage.removeItem(STATE_STORAGE_KEY);
            this.api
              .post<{ token?: string; user?: Record<string, unknown> }>('/api/user/auth/social-login', {
                token: payload.token,
              })
              .subscribe({
                next: (session) => {
                  this.auth.applySession(session.token, session.user);
                  this.wishlist.refresh();
                  void this.router.navigateByUrl('/');
                },
                error: (error: Error) =>
                  this.fail({
                    message: error.message || 'Không thể tạo phiên thành viên.',
                    code: 'SESSION_MINT_FAILED',
                    retryable: true,
                  }),
              });
          },
          error: (error: Error) =>
            this.fail({
              message: error.message || 'Xác thực Google thất bại.',
              code: 'PKCE_EXCHANGE_FAILED',
              retryable: true,
            }),
        });
      return;
    }

    this.fail({
      message: 'Không tìm thấy mã xác thực trong URL.',
      hint: 'Vui lòng bắt đầu lại quá trình đăng nhập từ trang Đăng nhập.',
      code: 'MISSING_AUTH_CODE',
      retryable: true,
    });
  }

  /**
   * Copies technical diagnosis code to clipboard for swift user support.
   */
  async copyCode(): Promise<void> {
    const code = this.technicalCode();
    if (!code || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(code);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      // Ignore clipboard write failures in restricted browser contexts
    }
  }

  /**
   * Initiates a fresh Google OAuth flow directly from callback page.
   */
  async retryGoogle(): Promise<void> {
    try {
      const redirectTo = `${window.location.origin}/auth/callback`;
      const verifier = this.randomVerifier();
      const state = this.randomVerifier();
      const challenge = await this.codeChallenge(verifier);
      localStorage.setItem(PKCE_STORAGE_KEY, verifier);
      localStorage.setItem(STATE_STORAGE_KEY, state);
      const url =
        `${environment.apiUrl}/api/auth/google` +
        `?redirect_to=${encodeURIComponent(redirectTo)}` +
        `&code_challenge=${encodeURIComponent(challenge)}` +
        `&state=${encodeURIComponent(state)}`;
      window.location.href = url;
    } catch {
      this.errorMessage.set('Không thể kết nối Google. Vui lòng đăng nhập bằng email hoặc số điện thoại.');
    }
  }

  private fail(err: OAuthErrorInfo | string): void {
    this.title.set('Xác thực thất bại');
    this.detail.set('');
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

  /**
   * Turns a GoTrue/Google OAuth error into actionable shopper messaging while preserving diagnostic context.
   */
  private describeProviderError(description: string, code: string): OAuthErrorInfo {
    const text = `${code} ${description}`.toLowerCase();

    if (
      text.includes('redirect_uri_not_allowed') ||
      text.includes('redirect_to is not allowed') ||
      text.includes('url not allowed')
    ) {
      return {
        message: 'Địa chỉ chuyển hướng xác thực chưa được cấp phép trong hệ thống.',
        hint: 'Vui lòng kiểm tra cấu hình Redirect URLs trên Supabase Console hoặc liên hệ quản trị viên.',
        code: code || 'REDIRECT_URI_NOT_ALLOWED',
        retryable: false,
      };
    }

    if (text.includes('redirect_uri_mismatch')) {
      return {
        message: 'URL chuyển hướng OAuth không khớp cấu hình Google Cloud. Vui lòng kiểm tra lại Authorized redirect URIs.',
        hint: 'Kiểm tra Authorized redirect URIs trong Google Cloud Console khớp với Supabase Callback.',
        code: code || 'REDIRECT_URI_MISMATCH',
        retryable: false,
      };
    }

    if (text.includes('provider is not enabled') || text.includes('unsupported provider')) {
      return {
        message: 'Đăng nhập Google chưa được bật trên hệ thống. Vui lòng đăng nhập bằng email hoặc số điện thoại.',
        hint: 'Tính năng Google Provider cần được bật trên Supabase Dashboard.',
        code: code || 'PROVIDER_DISABLED',
        retryable: false,
      };
    }

    if (text.includes('access_denied') || text.includes('denied access')) {
      return {
        message: 'Bạn đã huỷ đăng nhập Google. Vui lòng thử lại nếu muốn tiếp tục.',
        hint: 'Nhấn nút Thử lại bằng Google bên dưới để tiếp tục.',
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
        hint: 'Vui lòng thử lại sau vài phút hoặc đăng nhập bằng tài khoản email thông thường.',
        code: code || 'DATABASE_SERVER_ERROR',
        retryable: true,
      };
    }

    if (text.includes('identity_already_exists') || text.includes('user_already_exists')) {
      return {
        message: 'Email này đã tồn tại với hình thức đăng nhập khác.',
        hint: 'Vui lòng đăng nhập bằng mật khẩu tài khoản và liên kết Google sau.',
        code: code || 'IDENTITY_EXISTS',
        retryable: false,
      };
    }

    if (text.includes('invalid_grant') || text.includes('code_verifier')) {
      return {
        message: 'Mã xác thực Google đã hết hạn hoặc đã được sử dụng.',
        hint: 'Vui lòng thực hiện đăng nhập lại từ đầu.',
        code: code || 'INVALID_GRANT',
        retryable: true,
      };
    }

    return {
      message: 'Không thể xác thực với Google. Vui lòng đăng nhập bằng email hoặc số điện thoại.',
      hint: description || 'Đã xảy ra lỗi không xác định từ nhà cung cấp danh tính.',
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
