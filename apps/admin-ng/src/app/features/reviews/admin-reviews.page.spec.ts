import { createAdminPage } from '../../../testing/admin-testing';
import { AdminReviewsPage } from './admin-reviews.page';

describe('AdminReviewsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminReviewsPage);
    expect(page).toBeTruthy();
  });

  it('exposes loading and empty review signals', async () => {
    const page = await createAdminPage(AdminReviewsPage);
    expect(page.loading()).toBe(false);
    expect(page.rows()).toEqual([]);
    expect(page.loadError()).toBeNull();
  });
});
