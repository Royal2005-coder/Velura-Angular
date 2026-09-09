import { createStorefrontPage } from '../../../testing/storefront-testing';
import { OffersPage } from './offers.page';

describe('OffersPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(OffersPage);
    expect(page).toBeTruthy();
  });
});
