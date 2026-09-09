import { createAdminPage } from '../../../testing/admin-testing';
import { AdminFeaturePage } from './admin-feature.page';

describe('AdminFeaturePage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminFeaturePage);
    expect(page).toBeTruthy();
  });
});
