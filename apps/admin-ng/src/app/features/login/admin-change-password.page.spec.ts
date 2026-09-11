import { createAdminPage } from '../../../testing/admin-testing';
import { AdminChangePasswordPage } from './admin-change-password.page';

describe('AdminChangePasswordPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminChangePasswordPage);
    expect(page).toBeTruthy();
  });

  it('validates mismatch locally before calling the API', async () => {
    const page = await createAdminPage(AdminChangePasswordPage);
    page.form.setValue({ current: 'old-password-1', next: 'new-password-12', confirm: 'other-password' });
    page.submit();
    expect(page.errorMessage()).toContain('khớp');
    expect(page.backRoute()).toBe('/welcome');
  });
});
