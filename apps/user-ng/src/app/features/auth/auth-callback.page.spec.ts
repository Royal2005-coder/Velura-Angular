import { createStorefrontPage } from '../../../testing/storefront-testing';
import { AuthCallbackPage } from './auth-callback.page';

describe('AuthCallbackPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AuthCallbackPage);
    expect(page).toBeTruthy();
    expect(page.errorMessage()).toBe('Không tìm thấy mã xác thực trong URL.');
  });
});
