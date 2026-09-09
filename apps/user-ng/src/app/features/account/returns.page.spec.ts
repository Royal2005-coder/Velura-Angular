import { createStorefrontPage } from '../../../testing/storefront-testing';
import { AccountReturnsPage } from './returns.page';

describe('AccountReturnsPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AccountReturnsPage);
    expect(page).toBeTruthy();
  });
});
