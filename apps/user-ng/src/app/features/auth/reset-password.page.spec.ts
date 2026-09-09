import { createStorefrontPage } from '../../../testing/storefront-testing';
import { ResetPasswordPage } from './reset-password.page';

describe('ResetPasswordPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(ResetPasswordPage);
    expect(page).toBeTruthy();
  });
});
