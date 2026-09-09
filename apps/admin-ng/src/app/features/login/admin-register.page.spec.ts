import { createAdminPage } from '../../../testing/admin-testing';
import { AdminRegisterPage } from './admin-register.page';

describe('AdminRegisterPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminRegisterPage);
    expect(page).toBeTruthy();
  });
});
