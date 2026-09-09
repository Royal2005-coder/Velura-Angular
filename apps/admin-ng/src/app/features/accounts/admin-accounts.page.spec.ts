import { createAdminPage } from '../../../testing/admin-testing';
import { AdminAccountsPage } from './admin-accounts.page';

describe('AdminAccountsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminAccountsPage);
    expect(page).toBeTruthy();
  });
});
