import { createAdminPage } from '../../../testing/admin-testing';
import { AdminDashboardPage } from './admin-dashboard.page';

describe('AdminDashboardPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminDashboardPage);
    expect(page).toBeTruthy();
  });

  it('derives operations tab and alert total from dashboard signals', async () => {
    const page = await createAdminPage(AdminDashboardPage);
    expect(page.loading()).toBe(false);
    expect(page.tab()).toBe('operations');
    expect(page.alertTotal()).toBe(0);
    page.setTab('business');
    expect(page.tab()).toBe('business');
  });
});
