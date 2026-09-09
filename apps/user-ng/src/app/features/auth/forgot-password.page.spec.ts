import { createStorefrontPage } from '../../../testing/storefront-testing';
import { ForgotPasswordPage } from './forgot-password.page';

describe('ForgotPasswordPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(ForgotPasswordPage);
    expect(page).toBeTruthy();
  });
});
