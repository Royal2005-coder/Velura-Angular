import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { WishlistStore } from '../../core/services/wishlist.store';

const PKCE_STORAGE_KEY = 'velura-user-oauth-pkce-code-verifier';

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
    const code = new URL(window.location.href).searchParams.get('code');
    const verifier = localStorage.getItem(PKCE_STORAGE_KEY);
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
}
