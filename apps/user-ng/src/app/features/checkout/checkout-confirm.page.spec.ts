import { createStorefrontPage } from '../../../testing/storefront-testing';
import { CheckoutConfirmPage } from './checkout-confirm.page';

describe('CheckoutConfirmPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(CheckoutConfirmPage);
    expect(page).toBeTruthy();
  });
});
