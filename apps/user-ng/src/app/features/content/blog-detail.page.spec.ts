import { createStorefrontPage } from '../../../testing/storefront-testing';
import { BlogDetailPage } from './blog-detail.page';

describe('BlogDetailPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(BlogDetailPage);
    expect(page).toBeTruthy();
  });

  it('splits the CMS body into readable paragraphs without rendering raw markup', async () => {
    const page = await createStorefrontPage(BlogDetailPage);
    expect(page.paragraphs('Đoạn một\n\nĐoạn hai <script>alert(1)</script>')).toEqual([
      'Đoạn một',
      'Đoạn hai <script>alert(1)</script>',
    ]);
  });
});
