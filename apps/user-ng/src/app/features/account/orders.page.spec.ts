import { createStorefrontPage } from '../../../testing/storefront-testing';
import { AccountOrdersPage } from './orders.page';

describe('AccountOrdersPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AccountOrdersPage);
    expect(page).toBeTruthy();
  });
});
