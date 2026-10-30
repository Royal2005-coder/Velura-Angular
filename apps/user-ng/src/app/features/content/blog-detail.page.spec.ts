import { of } from 'rxjs';
import { createStorefrontPage, lastStorefrontFixture } from '../../../testing/storefront-testing';
import { BlogDetailPage } from './blog-detail.page';

const RICH_BLOG = {
  slug: 'heritage',
  title: 'Xu hướng màu sắc mùa thu',
  excerpt: 'Bảng màu mùa thu cho tủ đồ mới.',
  content: '',
  content_html: '<h2>Chất liệu</h2><p>Linen và lụa cho ngày giao mùa.</p><script>alert(1)</script><img src="javascript:alert(1)">',
  meta_title: 'Xu hướng màu sắc mùa thu 2026 | Velura',
  meta_description: 'Khám phá bảng màu mùa thu và cách phối đồ cùng Velura.',
  canonical_url: 'https://velura.vn/blog/heritage',
  og_image_url: 'https://cdn.velura.vn/og/heritage.jpg',
  tags: ['xu hướng', 'mùa thu'],
  image_url: 'https://cdn.velura.vn/blog/heritage.jpg',
  author: 'Nguyễn Thu Hà',
  read_minutes: 6,
  category_slug: 'trend',
  published_at: '2026-07-05T00:00:00.000Z',
  products: [{
    product_id: '30000000-0000-4000-8000-000000000001',
    name: 'Áo lụa Heritage',
    slug: 'ao-lua-heritage',
    images: ['https://cdn.velura.vn/p/ao-lua.jpg'],
    base_price: 590000,
    sale_price: 490000,
  }],
};

function richApi() {
  return {
    get: (path: string) => {
      if (/\/api\/content\/blogs\/[^/?]+$/.test(path)) return of(RICH_BLOG);
      if (path.includes('/content/blogs')) return of({ rows: [RICH_BLOG] });
      return of({});
    },
  };
}

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

  it('renders sanitized rich HTML and attached products for the article', async () => {
    await createStorefrontPage(BlogDetailPage, richApi());
    const fixture = lastStorefrontFixture();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('.article-rich h2')?.textContent).toContain('Chất liệu');
    expect(element.querySelector('.article-rich p')?.textContent).toContain('Linen và lụa');
    expect(element.querySelector('.article-rich script')).toBeNull();
    expect((element.querySelector('.article-rich img')?.getAttribute('src') ?? '').startsWith('javascript:')).toBe(false);
    expect(element.querySelector('.article-tag')?.textContent).toContain('xu hướng');
    expect(element.querySelectorAll('.sidebar-product').length).toBe(1);
    expect(element.querySelector('.sidebar-product__name')?.textContent).toContain('Áo lụa Heritage');
    expect(element.querySelector('.sidebar-product__link')?.getAttribute('href')).toContain('/products/ao-lua-heritage');
    expect(element.querySelector('.sidebar-product__price')?.textContent).toContain('490.000đ');
    fixture.destroy();
  });

  it('applies title, description, canonical, social cards and BlogPosting JSON-LD', async () => {
    await createStorefrontPage(BlogDetailPage, richApi());
    const fixture = lastStorefrontFixture();
    fixture.detectChanges();

    expect(document.title).toBe('Xu hướng màu sắc mùa thu 2026 | Velura');
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toContain('bảng màu mùa thu');
    expect(document.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe('https://cdn.velura.vn/og/heritage.jpg');
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://velura.vn/blog/heritage');
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    const payload = JSON.parse(scripts[scripts.length - 1]?.textContent || '{}') as Record<string, unknown>;
    expect(payload['@type']).toBe('BlogPosting');
    expect(payload['headline']).toBe('Xu hướng màu sắc mùa thu');
    expect(payload['author']).toEqual({ '@type': 'Person', name: 'Nguyễn Thu Hà' });
    expect(payload['keywords']).toBe('xu hướng, mùa thu');
    fixture.destroy();
  });
});
