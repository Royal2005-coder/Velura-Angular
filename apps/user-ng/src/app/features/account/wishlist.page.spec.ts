import { createStorefrontPage } from '../../../testing/storefront-testing';
import { WishlistPage } from './wishlist.page';

describe('WishlistPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(WishlistPage);
    expect(page).toBeTruthy();
  });
});
