import { createAdminPage } from '../../../testing/admin-testing';
import { AdminLogsPage } from './admin-logs.page';

describe('AdminLogsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminLogsPage);
    expect(page).toBeTruthy();
  });
});
