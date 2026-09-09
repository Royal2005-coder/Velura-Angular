import { createAdminPage } from '../../../testing/admin-testing';
import { AdminReturnsPage } from './admin-returns.page';

describe('AdminReturnsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    expect(page).toBeTruthy();
  });
});
