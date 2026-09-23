import { createStorefrontPage } from '../../../testing/storefront-testing';
import { AccountOrderDetailPage } from './order-detail.page';

describe('AccountOrderDetailPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AccountOrderDetailPage);
    expect(page).toBeTruthy();
  });

  it('lets the buyer cancel only before the parcel is handed to shipping', async () => {
    const page = await createStorefrontPage(AccountOrderDetailPage);
    expect(page.allowsCancel('pending')).toBe(true);
    expect(page.allowsCancel('confirmed')).toBe(true);
    expect(page.allowsCancel('preparing')).toBe(true);
    expect(page.allowsCancel('shipping')).toBe(false);
    expect(page.allowsCancel('delivered')).toBe(false);
    expect(page.allowsCancel('cancelled')).toBe(false);
  });
});
