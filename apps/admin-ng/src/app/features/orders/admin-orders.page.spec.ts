import { createAdminPage } from '../../../testing/admin-testing';
import { AdminOrdersPage } from './admin-orders.page';

describe('AdminOrdersPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminOrdersPage);
    expect(page).toBeTruthy();
  });
});
