import { createStorefrontPage } from '../../../testing/storefront-testing';
import { AccountProfilePage } from './profile.page';

describe('AccountProfilePage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AccountProfilePage);
    expect(page).toBeTruthy();
  });
});
