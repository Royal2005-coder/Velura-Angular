import { createStorefrontPage } from '../../../testing/storefront-testing';
import { AboutPage } from './about.page';

describe('AboutPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AboutPage);
    expect(page).toBeTruthy();
  });
});
