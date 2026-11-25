import { createStorefrontPage } from '../../../testing/storefront-testing';
import { of } from 'rxjs';
import { AuthCallbackPage } from './auth-callback.page';

describe('AuthCallbackPage', () => {
  const originalUrl = window.location.href;

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, '', originalUrl);
    localStorage.clear();
  });

  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page).toBeTruthy();
    expect(page.errorMessage()).toBe('Không tìm thấy mã xác thực trong URL.');
  });

  it('explains that Google sign-in is not enabled instead of reporting a missing code', async () => {
    window.history.replaceState(
      {},
      '',
      '/auth/callback?error=server_error&error_description=Unsupported+provider%3A+provider+is+not+enabled',
    );
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page.title()).toBe('Xác thực thất bại');
    expect(page.errorMessage()).toContain('Đăng nhập Google chưa được bật');
    expect(page.errorMessage()).not.toContain('mã xác thực');
    expect(page.technicalCode()).toBe('server_error');
  });

  it('shows the real GoTrue description for a generic server_error instead of blaming account storage', async () => {
    window.history.replaceState(
      {},
      '',
      '/auth/callback?error=server_error&error_description=Unable+to+exchange+external+code',
    );
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page.errorMessage()).not.toContain('lưu trữ thông tin tài khoản');
    expect(page.errorHint()).toContain('Unable to exchange external code');
    expect(page.technicalCode()).toBe('server_error');
  });

  it('treats a cancelled consent screen as a cancellation, not a failure to explain', async () => {
    window.history.replaceState({}, '', '/auth/callback?error=access_denied&error_description=User+denied+access');
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page.errorMessage()).toContain('huỷ đăng nhập Google');
    expect(page.canRetry()).toBe(true);
  });

  it('surfaces redirect_uri_not_allowed with actionable guidance', async () => {
    window.history.replaceState(
      {},
      '',
      '/auth/callback?error=redirect_uri_not_allowed&error_description=Redirect+URI+is+not+allowed',
    );
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page.errorMessage()).toContain('Địa chỉ chuyển hướng xác thực chưa được cấp phép');
    expect(page.errorHint()).toContain('Redirect URLs');
    expect(page.technicalCode()).toBe('redirect_uri_not_allowed');
  });

  it('rejects a callback whose returned state disagrees with the stored state', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      if (key === 'velura-user-oauth-state') return 'expected-state-12345678';
      if (key === 'velura-user-oauth-pkce-code-verifier') return 'verifier-123456';
      return null;
    });
    window.history.replaceState({}, '', '/auth/callback?code=some-code&state=forged-state-000000');
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page.technicalCode()).toBe('STATE_MISMATCH');
  });

  it('does not reject a PKCE callback that carries only code because GoTrue never echoes state', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      if (key === 'velura-user-oauth-state') return 'expected-state-12345678';
      if (key === 'velura-user-oauth-pkce-code-verifier') return 'verifier-123456';
      return null;
    });
    window.history.replaceState({}, '', '/auth/callback?code=some-code');
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page.technicalCode()).not.toBe('STATE_MISMATCH');
  });

  it('keeps an unknown provider error generic in message while exposing technical code and hint', async () => {
    window.history.replaceState({}, '', '/auth/callback?error=custom_oauth_fault&error_description=boom+internal+detail');
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page.errorMessage()).toBe(
      'Không thể xác thực với Google. Vui lòng đăng nhập bằng email hoặc số điện thoại.',
    );
    expect(page.errorMessage()).not.toContain('boom');
    expect(page.errorHint()).toBe('boom internal detail');
    expect(page.technicalCode()).toBe('custom_oauth_fault');
  });

  it('handles provider errors returned in hash fragment', async () => {
    window.history.replaceState(
      {},
      '',
      '/auth/callback#error=server_error&error_description=Unsupported+provider%3A+provider+is+not+enabled',
    );
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page.title()).toBe('Xác thực thất bại');
    expect(page.errorMessage()).toContain('Đăng nhập Google chưa được bật');
  });

  it('rejects unsolicited #access_token without matching stored state (Login-CSRF guard)', async () => {
    window.history.replaceState({}, '', '/auth/callback#access_token=attacker-token&token_type=bearer');
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page.title()).toBe('Xác thực thất bại');
    expect(page.technicalCode()).toBe('STATE_MISMATCH');
  });

  it('accepts direct access token with matching state and consumes stored OAuth returnUrl', async () => {
    const postSpy = vi.fn().mockReturnValue(of({ token: 'member-jwt', user: { user_id: 'u1' } }));
    window.history.replaceState({}, '', '/auth/callback#access_token=mock-access-token&state=state-123&token_type=bearer');
    const routes = [{ path: 'products/:id', component: class {} }];
    const page = await createStorefrontPage(
      AuthCallbackPage,
      { post: postSpy },
      {
        routes,
        localStorageSeed: {
          'velura-user-oauth-state': 'state-123',
          'velura-user-oauth-return-url': JSON.stringify({ url: '/products/p1?variant=v1&vto=1', expiresAt: Date.now() + 60000 }),
        },
      },
    );
    expect(page.errorMessage()).toBeNull();
    expect(localStorage.getItem('velura-user-oauth-return-url')).toBeNull();
  });

  it('exchanges PKCE code and preserves returnUrl navigation on success', async () => {
    const postSpy = vi.fn().mockImplementation((path: string) =>
      path === '/api/auth/pkce'
        ? of({ token: 'sb-jwt' })
        : of({ token: 'member-jwt', user: { user_id: 'u1' } }),
    );
    window.history.replaceState({}, '', '/auth/callback?code=pkce-code-1');
    const routes = [{ path: 'products/:id', component: class {} }];
    const page = await createStorefrontPage(
      AuthCallbackPage,
      { post: postSpy },
      {
        routes,
        localStorageSeed: {
          'velura-user-oauth-pkce-code-verifier': 'verifier-1',
          'velura-user-oauth-return-url': JSON.stringify({ url: '/products/p1?variant=v2&vto=1', expiresAt: Date.now() + 60000 }),
        },
      },
    );
    expect(page.errorMessage()).toBeNull();
    expect(postSpy).toHaveBeenCalledWith('/api/auth/pkce', expect.objectContaining({ auth_code: 'pkce-code-1', code_verifier: 'verifier-1' }));
    expect(localStorage.getItem('velura-user-oauth-return-url')).toBeNull();
  });
});
