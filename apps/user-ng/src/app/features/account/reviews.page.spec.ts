import { createStorefrontPage } from '../../../testing/storefront-testing';
import { AccountReviewsPage } from './reviews.page';

describe('AccountReviewsPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AccountReviewsPage);
    expect(page).toBeTruthy();
  });

  it('stores star rating on a signal', async () => {
    const page = await createStorefrontPage(AccountReviewsPage);
    expect(page.rating()).toBe(0);
    page.setRating(4);
    expect(page.rating()).toBe(4);
  });
});
