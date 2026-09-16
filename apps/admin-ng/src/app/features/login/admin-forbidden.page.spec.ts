import { createAdminPage } from '../../../testing/admin-testing';
import { AdminForbiddenPage } from './admin-forbidden.page';

describe('AdminForbiddenPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminForbiddenPage);
    expect(page).toBeTruthy();
    expect(page.homeRoute).toContain('/');
  });
});
