import { createAdminPage } from '../../../testing/admin-testing';
import { AdminAuthCallbackPage } from './admin-auth-callback.page';

describe('AdminAuthCallbackPage', () => {
  it('fails closed when the URL has no PKCE code', async () => {
    const page = await createAdminPage(AdminAuthCallbackPage);
    expect(page.failed()).toBe(true);
    expect(page.errorMessage()).toContain('mã xác thực');
  });
});
