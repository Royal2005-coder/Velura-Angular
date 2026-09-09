import { createStorefrontPage } from '../../../testing/storefront-testing';
import { CheckoutShippingPage } from './checkout-shipping.page';

describe('CheckoutShippingPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(CheckoutShippingPage);
    expect(page).toBeTruthy();
  });
});
