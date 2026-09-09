import { createAdminPage } from '../../../testing/admin-testing';
import { AdminPricingPage } from './admin-pricing.page';

describe('AdminPricingPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminPricingPage);
    expect(page).toBeTruthy();
  });
});
