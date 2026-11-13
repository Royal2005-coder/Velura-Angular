import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';
import { AdminApiService } from '../../core/admin-api.service';
import { adminErrorMessage } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';
import { useBodyClass } from '../../core/body-class';

const PKCE_STORAGE_KEY = 'velura-oauth-pkce-code-verifier';
const STATE_STORAGE_KEY = 'velura-admin-oauth-state';

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
 * Handles admin OAuth callback with transparent error diagnostics and one-click retry.
 */
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
        @if (errorHint()) {
          <p class="auth-hint" style="margin-top: 6px; font-size: 12px; color: #64748b;">{{ errorHint() }}</p>
        }
        @if (technicalCode()) {
          <div class="auth-diagnostic" style="margin: 8px 0; padding: 6px 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 11px; display: flex; align-items: center; justify-content: space-between; gap: 6px;">
            <span>Mã kỹ thuật: <code>{{ technicalCode() }}</code></span>
            <button type="button" (click)="copyCode()" style="background: transparent; border: 1px solid #cbd5e1; padding: 2px 6px; border-radius: 4px; font-size: 10px; cursor: pointer;">
              {{ copied() ? 'Đã sao chép' : 'Sao chép' }}
            </button>
          </div>
        }
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px;">
          @if (canRetry()) {
            <button type="button" class="verification-btn" (click)="retryGoogle()">Thử lại bằng Google</button>
          }
          <a class="verification-btn verification-btn--secondary" routerLink="/login" style="text-align: center; text-decoration: none;">Quay lại đăng nhập</a>
        </div>
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
  readonly errorHint = signal<string | null>(null);
  readonly technicalCode = signal<string | null>(null);
  readonly canRetry = signal(false);
  readonly copied = signal(false);
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
    const state = params.get('state');
    const expectedState = localStorage.getItem(STATE_STORAGE_KEY);

    if (expectedState && (!state || state !== expectedState)) {
      this.cleanStorage();
      this.fail({
        message: 'Mã bảo mật state không khớp hoặc bị thiếu.',
        hint: 'Yêu cầu có thể đã bị can thiệp hoặc hết hạn.',
        code: 'STATE_MISMATCH',
        retryable: true,
      });
      return;
    }

    // Direct token flow (implicit grant or hash fragment)
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
            message: adminErrorMessage(error, 'Xác thực thất bại'),
            code: 'PKCE_EXCHANGE_FAILED',
            retryable: true,
          }),
      });
      return;
    }

    this.fail({
      message: 'Không tìm thấy mã xác thực trong URL.',
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
      // Ignore
    }
  }

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
      this.errorMessage.set('Không thể kết nối Google. Vui lòng đăng nhập bằng mật khẩu.');
    }
  }

  private cleanStorage(): void {
    localStorage.removeItem(PKCE_STORAGE_KEY);
    localStorage.removeItem(STATE_STORAGE_KEY);
  }

  private fail(err: OAuthErrorInfo | string): void {
    this.failed.set(true);
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
        hint: 'Kiểm tra Authorized redirect URIs trong Google Cloud Console.',
        code: code || 'REDIRECT_URI_MISMATCH',
        retryable: false,
      };
    }

    if (text.includes('provider is not enabled') || text.includes('unsupported provider')) {
      return {
        message: 'Đăng nhập Google SSO chưa được bật trên hệ thống.',
        hint: 'Kích hoạt Google Provider trên Supabase Cloud Dashboard.',
        code: code || 'PROVIDER_DISABLED',
        retryable: false,
      };
    }

    if (text.includes('access_denied') || text.includes('denied access')) {
      return {
        message: 'Bạn đã huỷ đăng nhập Google.',
        hint: 'Nhấn nút Thử lại bằng Google bên dưới nếu muốn tiếp tục.',
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
      message: 'Không thể xác thực với Google.',
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
