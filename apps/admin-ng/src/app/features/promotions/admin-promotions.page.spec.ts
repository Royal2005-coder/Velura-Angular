import { createAdminPage } from '../../../testing/admin-testing';
import { AdminPromotionsPage } from './admin-promotions.page';

describe('AdminPromotionsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminPromotionsPage);
    expect(page).toBeTruthy();
  });

  it('exposes loading and empty campaign signals', async () => {
    const page = await createAdminPage(AdminPromotionsPage);
    expect(page.loading()).toBe(false);
    expect(page.promotions()).toEqual([]);
    expect(page.loadError()).toBeNull();
  });
});
