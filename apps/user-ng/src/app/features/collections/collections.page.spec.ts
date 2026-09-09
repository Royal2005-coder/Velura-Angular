import { createStorefrontPage } from '../../../testing/storefront-testing';
import { CollectionsPage } from './collections.page';

describe('CollectionsPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(CollectionsPage);
    expect(page).toBeTruthy();
  });
});
