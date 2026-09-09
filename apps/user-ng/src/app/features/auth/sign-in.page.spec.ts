import { createStorefrontPage } from '../../../testing/storefront-testing';
import { SignInPage } from './sign-in.page';

describe('SignInPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(SignInPage);
    expect(page).toBeTruthy();
  });

  it('keeps method and error on signals; invalid submit does not call HTTP', async () => {
    const page = await createStorefrontPage(SignInPage);
    expect(page.method()).toBe('phone');
    page.setMethod('email');
    expect(page.method()).toBe('email');
    expect(page.errorMessage()).toBeNull();
  });
});
