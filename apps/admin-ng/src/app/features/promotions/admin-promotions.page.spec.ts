import { createAdminPage } from '../../../testing/admin-testing';
import { AdminPromotionsPage } from './admin-promotions.page';

describe('AdminPromotionsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminPromotionsPage);
    expect(page).toBeTruthy();
  });
});
