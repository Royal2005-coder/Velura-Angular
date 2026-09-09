import { createStorefrontPage } from '../../../testing/storefront-testing';
import { AccountOrderDetailPage } from './order-detail.page';

describe('AccountOrderDetailPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AccountOrderDetailPage);
    expect(page).toBeTruthy();
  });
});
