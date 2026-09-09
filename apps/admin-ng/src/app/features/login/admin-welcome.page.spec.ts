import { createAdminPage } from '../../../testing/admin-testing';
import { AdminWelcomePage } from './admin-welcome.page';

describe('AdminWelcomePage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminWelcomePage);
    expect(page).toBeTruthy();
  });
});
