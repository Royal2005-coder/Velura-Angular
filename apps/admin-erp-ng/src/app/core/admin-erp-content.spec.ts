import { environment } from '../../environments/environment';
import type { AdminCollectionRow } from './admin-erp-api.service';
import {
  blogRequestBody,
  blogSlugFromTitle,
  blogStatusChoices,
  blogStatusLabel,
  blogStatusTone,
  collectionCodeFromName,
  collectionRequestBody,
  computeMediaFraming,
  emptyBlogDraft,
  homeRunwaySummary,
  moveListItem,
  resolveStorefrontAsset,
  validateBannerDraft,
  validateBlogDraft,
  validateCollectionDraft,
  type BlogDraft,
} from './admin-erp-content';

function draft(overrides: Partial<BlogDraft> = {}): BlogDraft {
  return {
    ...emptyBlogDraft,
    slug: 'ao-lua-ha-noi',
    title: 'Áo lụa Hà Nội mặc thế nào',
    categorySlug: 'cham-soc',
    content: 'Nội dung bài viết đủ dài để vượt qua ngưỡng kiểm tra của frontend và của RPC.',
    ...overrides,
  };
}

describe('admin CMS blog rules', () => {
  it('accepts a well-formed draft and reports nothing', () => {
    expect(validateBlogDraft(draft(), false)).toEqual({});
  });

  it('rejects each field the RPC rejects, keyed by that field', () => {
    const cases: Array<[string, Partial<BlogDraft>]> = [
      ['slug', { slug: 'Áo Lụa Hà Nội' }],
      ['slug', { slug: 'a' }],
      ['title', { title: 'Ngắ' }],
      ['categorySlug', { categorySlug: '  ' }],
      ['content', { content: 'quá ngắn' }],
      ['excerpt', { excerpt: 'x'.repeat(501) }],
      ['imageUrl', { imageUrl: 'http://cdn.example/a.jpg' }],
      ['readMinutes', { readMinutes: 0 }],
      ['readMinutes', { readMinutes: 61 }],
    ];
    for (const [field, overrides] of cases) {
      const errors = validateBlogDraft(draft(overrides), false);
      expect(Object.keys(errors)).toEqual([field]);
    }
  });

  it('keeps archived out of creation but allows it once the post exists', () => {
    expect(validateBlogDraft(draft({ status: 'archived' }), false)['status']).toBeTruthy();
    expect(validateBlogDraft(draft({ status: 'archived' }), true)['status']).toBeUndefined();
  });

  it('follows the server transition table', () => {
    expect(blogStatusChoices(undefined, true)).toEqual(['draft', 'published']);
    expect(blogStatusChoices('draft', false)).toEqual(['draft', 'published', 'archived']);
    expect(blogStatusChoices('published', false)).toEqual(['published', 'draft', 'archived']);
    expect(blogStatusChoices('archived', false)).toEqual(['archived', 'draft']);
  });

  it('labels and tones the three states for badges', () => {
    expect(blogStatusLabel('draft')).toBe('Bản nháp');
    expect(blogStatusLabel('unknown-code')).toBe('unknown-code');
    expect(blogStatusTone('published')).toBe('success');
    expect(blogStatusTone('archived')).toBe('warning');
  });

  it('slugifies Vietnamese titles inside the 120-character ceiling', () => {
    expect(blogSlugFromTitle('Áo Dài Cách Tân 2026!')).toBe('ao-dai-cach-tan-2026');
    expect(blogSlugFromTitle('đ'.repeat(200)).length).toBeLessThanOrEqual(120);
  });

  it('builds a body with clean fields and only sends a version when editing', () => {
    const body = blogRequestBody(draft({ slug: '  Ao-Lua ', title: '  Tiêu đề  ', imageUrl: '  ', author: '  ' }), 7);
    expect(body.slug).toBe('ao-lua');
    expect(body.title).toBe('Tiêu đề');
    expect(body.imageUrl).toBeNull();
    expect(body.author).toBe('Velura Editorial');
    expect(body.expectedVersion).toBe(7);
    expect(blogRequestBody(draft(), undefined).expectedVersion).toBeUndefined();
  });
});

describe('resolveStorefrontAsset', () => {
  it('prefixes /assets paths with the storefront origin', () => {
    expect(resolveStorefrontAsset('/assets/x.png')).toBe(`${environment.storefrontUrl}/assets/x.png`);
    expect(resolveStorefrontAsset('/assets/x.png', 'https://shop.example/')).toBe('https://shop.example/assets/x.png');
  });

  it('keeps absolute, data and protocol-relative values and maps empty to empty', () => {
    expect(resolveStorefrontAsset('https://a/b')).toBe('https://a/b');
    expect(resolveStorefrontAsset('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(resolveStorefrontAsset('//evil.example/x.png')).toBe('//evil.example/x.png');
    expect(resolveStorefrontAsset('')).toBe('');
    expect(resolveStorefrontAsset(null)).toBe('');
  });
});

describe('admin CMS banner rules', () => {
  it('requires a title and media and rejects javascript links', () => {
    const errors = validateBannerDraft({ title: ' ', media_url: '', link_url: 'javascript:alert(1)' });
    expect(Object.keys(errors).sort()).toEqual(['link_url', 'media_url', 'title']);
    expect(validateBannerDraft({ title: 'Mùa thu', media_url: 'https://cdn.example/a.jpg', link_url: '/products' })).toEqual({});
  });
});

describe('admin CMS collection rules', () => {
  const five = ['/assets/1.png', '/assets/2.png', '/assets/3.png', '/assets/4.png', '/assets/5.png'];
  const base: Partial<AdminCollectionRow> = {
    name: 'Soft Ceremony',
    code: 'soft-ceremony',
    story_desc: 'Câu chuyện bộ sưu tập.',
    hero_mode: 'models',
    models: five,
    is_active: true,
  };
  const ctx = { editing: false, otherHomeSlotsUsed: 0 };

  it('accepts a complete collection', () => {
    expect(validateCollectionDraft(base, ctx)).toEqual({});
  });

  it('needs five cutouts in models mode but only a cover in cover mode', () => {
    expect(validateCollectionDraft({ ...base, models: five.slice(0, 4) }, ctx)['models']).toContain('5');
    expect(validateCollectionDraft({ ...base, hero_mode: 'cover', models: [] }, ctx)['banner_url']).toBeTruthy();
    expect(validateCollectionDraft({ ...base, hero_mode: 'cover', models: [], banner_url: '/assets/cover.jpg' }, ctx)).toEqual({});
  });

  it('requires a homepage model when show_on_home and caps the runway at five', () => {
    expect(validateCollectionDraft({ ...base, show_on_home: true }, ctx)['home_model_url']).toBeTruthy();
    const withModel = { ...base, show_on_home: true, home_model_url: '/assets/home.png' };
    expect(validateCollectionDraft(withModel, ctx)).toEqual({});
    expect(validateCollectionDraft(withModel, { editing: false, otherHomeSlotsUsed: 5 })['show_on_home']).toBeTruthy();
  });

  it('builds a body with the new fields, no label, and immutable code when editing', () => {
    const body = collectionRequestBody({ ...base, product_ids: ['a', 'a', 'b'], home_model_url: ' /assets/h.png ', show_on_home: true, home_sort_order: 2 }, false);
    expect(body.code).toBe('soft-ceremony');
    expect('label' in body).toBe(false);
    expect(body.hero_mode).toBe('models');
    expect(body.product_ids).toEqual(['a', 'b']);
    expect(body.home_model_url).toBe('/assets/h.png');
    expect(body.show_on_home).toBe(true);
    expect(body.home_sort_order).toBe(2);
    expect('code' in collectionRequestBody(base, true)).toBe(false);
  });

  it('moves list items and ignores out-of-range moves', () => {
    expect(moveListItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveListItem(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
  });

  it('summarises the homepage runway', () => {
    const row = (name: string, url: string | null, on = true) => ({ name, is_active: true, show_on_home: on, home_model_url: url });
    const summary = homeRunwaySummary([row('A', '/assets/a.png'), row('B', null), row('C', '/assets/a.png'), row('D', 'x', false)]);
    expect(summary.count).toBe(2);
    expect(summary.complete).toBe(false);
    expect(summary.missingModel).toEqual(['B']);
    expect(summary.duplicateModel).toEqual(['A', 'C']);
  });

  it('generates clean collection slugs without trailing hyphens and forwards styling_metadata framing', () => {
    expect(collectionCodeFromName('Bộ Sưu Tập Mùa Thu Đông — Ánh Hoàng Hôn Rực Rỡ Giữa Phố Thị 2027')).not.toMatch(/-$/);
    expect(collectionCodeFromName('Midnight Mirage · After Dark')).toBe('midnight-mirage-after-dark');

    const framed = computeMediaFraming(42.54, 14.22, 1.35, 16);
    expect(framed.objectPosition).toBe('42.5% 14.2%');
    expect(framed.transform).toBe('scale(1.35)');
    expect(computeMediaFraming(undefined, undefined, 1, 16)).toEqual({
      posX: 50,
      posY: 16,
      zoom: 1,
      objectPosition: '50% 16%',
      transformOrigin: '50% 16%',
      transform: null,
    });

    const editBody = collectionRequestBody(
      { ...base, styling_metadata: { cover_x: 42.5, cover_y: 14.2, cover_zoom: 1.35 } },
      true,
    );
    expect(editBody.styling_metadata).toEqual({ cover_x: 42.5, cover_y: 14.2, cover_zoom: 1.35 });
    expect('hero_gradient' in editBody).toBe(false);
    expect('category_link' in editBody).toBe(false);
    expect(validateCollectionDraft({ ...base, category_link: `/${'a'.repeat(260)}` }, ctx)['category_link']).toBeTruthy();
  });
});
