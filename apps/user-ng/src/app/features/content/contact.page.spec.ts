import { createStorefrontPage } from '../../../testing/storefront-testing';
import { ContactPage } from './contact.page';

describe('ContactPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(ContactPage);
    expect(page).toBeTruthy();
  });
});
