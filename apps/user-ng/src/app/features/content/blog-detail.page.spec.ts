import { createStorefrontPage } from '../../../testing/storefront-testing';
import { BlogDetailPage } from './blog-detail.page';

describe('BlogDetailPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(BlogDetailPage);
    expect(page).toBeTruthy();
  });
});
