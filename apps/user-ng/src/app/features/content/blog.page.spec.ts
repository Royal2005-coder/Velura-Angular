import { createStorefrontPage } from '../../../testing/storefront-testing';
import { BlogPage } from './blog.page';

describe('BlogPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(BlogPage);
    expect(page).toBeTruthy();
  });
});
