import { createAdminPage } from '../../../testing/admin-testing';
import { AdminAccountsPage } from './admin-accounts.page';

describe('AdminAccountsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminAccountsPage);
    expect(page).toBeTruthy();
  });

  it('exposes loading, empty, and filter signals instead of template filters', async () => {
    const page = await createAdminPage(AdminAccountsPage);
    expect(page.loading()).toBe(false);
    expect(page.rows()).toEqual([]);
    expect(page.loadError()).toBeNull();
    page.query.set('linh');
    page.roleFilter.set('member');
    expect(page.query()).toBe('linh');
    expect(page.roleFilter()).toBe('member');
  });
});
