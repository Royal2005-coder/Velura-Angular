import { createStorefrontPage } from '../../../testing/storefront-testing';
import { AuthCallbackPage } from './auth-callback.page';

describe('AuthCallbackPage', () => {
  const originalUrl = window.location.href;

  afterEach(() => {
    window.history.replaceState({}, '', originalUrl);
    localStorage.clear();
  });

  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page).toBeTruthy();
    expect(page.errorMessage()).toBe('Không tìm thấy mã xác thực trong URL.');
  });

  // GoTrue answers a provider it has no credentials for with ?error=...&error_description=... on the
  // redirect, never with ?code=. Without this branch the shopper saw "no code in URL", which reads
  // like a broken link instead of a deployment gap.
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
  });

  it('treats a cancelled consent screen as a cancellation, not a failure to explain', async () => {
    window.history.replaceState({}, '', '/auth/callback?error=access_denied&error_description=User+denied+access');
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page.errorMessage()).toContain('huỷ đăng nhập Google');
  });

  it('keeps an unknown provider error generic rather than echoing raw provider text', async () => {
    window.history.replaceState({}, '', '/auth/callback?error=server_error&error_description=boom+internal+detail');
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page.errorMessage()).toBe(
      'Không thể xác thực với Google. Vui lòng đăng nhập bằng email hoặc số điện thoại.',
    );
    expect(page.errorMessage()).not.toContain('boom');
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
    // In test harness without social-login backend response, errorMessage won't be "no code in URL"
    expect(page.errorMessage()).not.toBe('Không tìm thấy mã xác thực trong URL.');
  });
});
