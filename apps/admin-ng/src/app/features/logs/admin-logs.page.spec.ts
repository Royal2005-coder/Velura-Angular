import { createAdminPage } from '../../../testing/admin-testing';
import { AdminLogsPage } from './admin-logs.page';

describe('AdminLogsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminLogsPage);
    expect(page).toBeTruthy();
  });

  it('exposes loading, empty, and filter signals instead of template filters', async () => {
    const page = await createAdminPage(AdminLogsPage);
    expect(page.loading()).toBe(false);
    expect(page.rows()).toEqual([]);
    expect(page.loadError()).toBeNull();
    page.query.set('lock');
    page.module.set('accounts');
    expect(page.query()).toBe('lock');
    expect(page.module()).toBe('accounts');
  });
});
