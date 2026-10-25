import {
  blogRequestBody,
  blogSlugFromTitle,
  blogStatusChoices,
  blogStatusLabel,
  blogStatusTone,
  emptyBlogDraft,
  validateBlogDraft,
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
