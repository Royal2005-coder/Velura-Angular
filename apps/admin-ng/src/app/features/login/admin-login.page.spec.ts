import { createAdminPage } from '../../../testing/admin-testing';
import { AdminLoginPage } from './admin-login.page';

describe('AdminLoginPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminLoginPage);
    expect(page).toBeTruthy();
  });

  it('rejects an empty form in the ViewModel without calling signIn', async () => {
    const page = await createAdminPage(AdminLoginPage);
    page.submit();
    expect(page.errorMessage()).toBe('Vui lòng nhập đầy đủ email và mật khẩu.');
    expect(page.submitting()).toBe(false);
  });
});
