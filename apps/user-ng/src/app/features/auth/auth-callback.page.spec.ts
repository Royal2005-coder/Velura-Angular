import { createStorefrontPage } from '../../../testing/storefront-testing';
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

  it('enforces strict state matching against CSRF when state parameter is missing', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      if (key === 'velura-user-oauth-state') return 'expected-state-12345678';
      if (key === 'velura-user-oauth-pkce-code-verifier') return 'verifier-123456';
      return null;
    });
    window.history.replaceState({}, '', '/auth/callback?code=some-code');
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page.errorMessage()).toContain('Mã định danh bảo mật (state) không khớp hoặc bị thiếu');
    expect(page.technicalCode()).toBe('STATE_MISMATCH');
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

  it('accepts direct access token returned in hash fragment', async () => {
    window.history.replaceState({}, '', '/auth/callback#access_token=mock-access-token&token_type=bearer');
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page).toBeTruthy();
    expect(page.errorMessage()).not.toBe('Không tìm thấy mã xác thực trong URL.');
  });
});
