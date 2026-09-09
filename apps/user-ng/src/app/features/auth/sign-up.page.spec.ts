import { createStorefrontPage } from '../../../testing/storefront-testing';
import { SignUpPage } from './sign-up.page';

describe('SignUpPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(SignUpPage);
    expect(page).toBeTruthy();
  });
});
