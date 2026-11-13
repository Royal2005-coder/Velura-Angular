import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { WishlistStore } from '../../core/services/wishlist.store';

const PKCE_STORAGE_KEY = 'velura-user-oauth-pkce-code-verifier';
const STATE_STORAGE_KEY = 'velura-user-oauth-state';

/**
 * Completes storefront Google PKCE the same way admin `/auth/callback` does:
 * exchange the auth code, then mint a Velura member session.
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
            <div class="field__error" role="alert">{{ errorMessage() }}</div>
            <a class="btn-login" routerLink="/auth/signin">Quay lại đăng nhập</a>
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

  constructor() {
    const params = new URL(window.location.href).searchParams;
    // GoTrue reports a rejected provider or consent screen as ?error=...&error_description=...,
    // not as a missing code. Surface that reason instead of a generic "no code" message.
    const providerError = params.get('error_description') || params.get('error');
    if (providerError) {
      this.fail(this.describeProviderError(providerError, params.get('error') || ''));
      return;
    }
    const code = params.get('code');
    const verifier = localStorage.getItem(PKCE_STORAGE_KEY);
    const storedState = localStorage.getItem(STATE_STORAGE_KEY);
    const returnedState = params.get('state');

    // Protect against Login CSRF: if a state challenge was dispatched, it must match byte-for-byte.
    if (storedState && returnedState !== storedState) {
      localStorage.removeItem(PKCE_STORAGE_KEY);
      localStorage.removeItem(STATE_STORAGE_KEY);
      this.fail('Mã định danh bảo mật (state) không khớp. Yêu cầu đăng nhập có thể đã bị can thiệp.');
      return;
    }

    if (!code || !verifier) {
      this.fail('Không tìm thấy mã xác thực trong URL.');
      return;
    }
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
            this.fail('Không nhận được phiên Google.');
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
              error: (error: Error) => this.fail(error.message || 'Không thể tạo phiên thành viên.'),
            });
        },
        error: (error: Error) => this.fail(error.message || 'Xác thực Google thất bại.'),
      });
  }

  private fail(message: string): void {
    this.title.set('Xác thực thất bại');
    this.detail.set('');
    this.errorMessage.set(message);
  }

  /**
   * Turns a GoTrue OAuth error into something a shopper can act on. An unconfigured provider is a
   * deployment problem, not a user mistake, so it must not read like a bad password.
   * The machine code lives in `error` while `error_description` is human prose ("User denied
   * access"), so both are matched.
   */
  private describeProviderError(description: string, code: string): string {
    const text = `${code} ${description}`.toLowerCase();
    if (text.includes('provider is not enabled') || text.includes('unsupported provider')) {
      return 'Đăng nhập Google chưa được bật trên hệ thống. Vui lòng đăng nhập bằng email hoặc số điện thoại.';
    }
    if (text.includes('access_denied') || text.includes('denied access')) {
      return 'Bạn đã huỷ đăng nhập Google. Vui lòng thử lại nếu muốn tiếp tục.';
    }
    return 'Không thể xác thực với Google. Vui lòng đăng nhập bằng email hoặc số điện thoại.';
  }
}
