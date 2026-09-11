import { createAdminPage } from '../../../testing/admin-testing';
import { AdminOrdersPage } from './admin-orders.page';

describe('AdminOrdersPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminOrdersPage);
    expect(page).toBeTruthy();
  });

  it('exposes loading, empty, and error list signals', async () => {
    const page = await createAdminPage(AdminOrdersPage);
    expect(page.loading()).toBe(false);
    expect(page.rows()).toEqual([]);
    expect(page.loadError()).toBeNull();
  });
});
