import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AdminBlogRow, AdminContentCategory, AdminErpApiService } from '../../core/admin-erp-api.service';
import { AdminErpSessionService, type AdminAuthMe } from '../../core/admin-erp-session.service';
import { AdminErpContentPage } from './admin-erp-content.page';

const POSTS: AdminBlogRow[] = [
  {
    blog_id: 'b-1',
    slug: 'ao-lua',
    title: 'Áo lụa Hà Nội',
    category_slug: 'cham-soc',
    status: 'published',
    version: 3,
    read_minutes: 4,
    excerpt: 'Guide ngắn',
    content: 'Nội dung bài viết đủ dài để vượt qua ngưỡng kiểm tra của frontend và của RPC CMS.',
    author: 'Velura Editorial',
    is_featured: true,
  },
  { blog_id: 'b-2', slug: 'cach-chon-size', title: 'Cách chọn size', category_slug: 'blog-size', status: 'draft', version: 1, read_minutes: 5, content: 'Hướng dẫn chi tiết cách đo và chọn size áo lụa cho khách mua online.' },
];

const CATEGORIES: AdminContentCategory[] = [
  { content_category_id: 'c-1', content_type: 'blog', slug: 'cham-soc', name: 'Chăm sóc áo' },
  { content_category_id: 'c-2', content_type: 'blog', slug: 'blog-size', name: 'Hướng dẫn size' },
];

function context(capabilities: Record<string, string[]>): AdminAuthMe {
  return {
    role: 'super_admin',
    roleName: 'Quản trị',
    isAdmin: true,
    allowedPages: ['content', 'dashboard'],
    allowedModules: ['content'],
    capabilities,
    user: { id: 'u1', email: 'root@velura.test' },
    profile: { user_id: 'u1', email: 'root@velura.test', full_name: 'Root', is_active: true },
  } as AdminAuthMe;
}

describe('AdminErpContentPage', () => {
  interface Harness {
    page: AdminErpContentPage;
    created: Record<string, unknown>[];
    updated: { id: string; body: Record<string, unknown> }[];
    listCalls: Record<string, string>[];
  }

  function boot(capabilities: Record<string, string[]> = { content: ['read', 'create', 'update'] }, failure?: unknown): Harness {
    TestBed.resetTestingModule();
    const created: Record<string, unknown>[] = [];
    const updated: { id: string; body: Record<string, unknown> }[] = [];
    const listCalls: Record<string, string>[] = [];
    const api = {
      listBlogs: (params: Record<string, string> = {}) => {
        listCalls.push(params);
        if (params['q']) return of({ rows: [{ ...POSTS[0], version: 7, title: 'Bản mới nhất' }], count: 1 });
        const status = params['status'];
        if (status === 'draft') return of({ rows: [POSTS[1]], count: 1 });
        if (status === 'published') return of({ rows: [POSTS[0]], count: 4 });
        if (status === 'archived') return of({ rows: [], count: 0 });
        return of({ rows: POSTS, count: 6 });
      },
      listContentCategories: () => of({ rows: CATEGORIES }),
      createBlog: (body: Record<string, unknown>) => {
        created.push(body);
        return failure ? throwError(() => failure) : of({ ...POSTS[1], ...body, blog_id: 'b-9', version: 1 });
      },
      updateBlog: (id: string, body: Record<string, unknown>) => {
        updated.push({ id, body });
        return failure ? throwError(() => failure) : of({ ...POSTS[0], ...body, version: 4 });
      },
    };
    TestBed.configureTestingModule({
      imports: [AdminErpContentPage],
      providers: [provideRouter([]), { provide: AdminErpApiService, useValue: api }],
    });
    TestBed.inject(AdminErpSessionService).applyAuthContext(context(capabilities));
    const fixture = TestBed.createComponent(AdminErpContentPage);
    fixture.detectChanges();
    return { page: fixture.componentInstance, created, updated, listCalls };
  }

  const validDraft = {
    slug: 'ao-dai',
    title: 'Áo dài cách tân cho mùa thu',
    categorySlug: 'cham-soc',
    status: 'published',
    excerpt: 'Gợi ý mặc áo dài',
    content: 'Nội dung bài viết đủ dài để vượt ngưỡng kiểm tra của cả frontend lẫn RPC CMS.',
    imageUrl: '',
    author: 'Velura Editorial',
    readMinutes: 6,
    isFeatured: true,
  };

  it('loads the queue with per-status counts and real categories', () => {
    const { page, listCalls } = boot();

    expect(page.rows().length).toBe(2);
    expect(page.total()).toBe(6);
    expect(page.counts()).toEqual({ draft: 1, published: 4, archived: 0, categories: 2 });
    expect(page.canEdit()).toBe(true);
    expect(listCalls.some((params) => params['status'] === 'draft')).toBe(true);
    page.openEdit(POSTS[0]);
    expect(page.categoryLabel('cham-soc')).toBe('Chăm sóc áo');
    expect(page.statusChoices().length).toBeGreaterThan(1);
  });

  it('refuses to open the editor without the write capability', () => {
    const { page, created } = boot({ content: ['read'] });

    expect(page.canEdit()).toBe(false);
    page.openCreate();
    expect(page.draft()).toBeNull();
    expect(created.length).toBe(0);
  });

  it('blocks an invalid draft locally and never calls the RPC', () => {
    const { page, created } = boot();
    page.openCreate();
    page.draft.set({ ...validDraft, slug: 'Áo Dài', content: 'ngắn', categorySlug: '' });
    page.save();

    expect(created.length).toBe(0);
    expect(Object.keys(page.errors()).sort()).toEqual(['categorySlug', 'content', 'slug']);
  });

  it('creates a post with the body shape the RPC expects', () => {
    const { page, created } = boot();
    page.openCreate();
    page.draft.set({ ...validDraft });
    page.save();

    expect(created.length).toBe(1);
    const body = created[0] as Record<string, unknown>;
    expect(body['slug']).toBe('ao-dai');
    expect(body['status']).toBe('published');
    expect(body['expectedVersion']).toBeUndefined();
    expect(page.draft()).toBeNull();
    expect(page.notice()).toContain('Đã tạo');
  });

  it('sends the loaded version when editing, and keeps the text on a conflict', () => {
    const conflict = new HttpErrorResponse({
      status: 409,
      error: { error: { code: 'VERSION_CONFLICT', message: 'Bài viết vừa được người khác sửa.' } },
    });
    const { page, updated } = boot({ content: ['read', 'create', 'update'] }, conflict);
    page.openEdit(POSTS[0]);
    page.save();

    expect(updated.length).toBe(1);
    expect(updated[0].id).toBe('b-1');
    expect((updated[0].body as Record<string, unknown>)['expectedVersion']).toBe(3);
    expect(page.conflict()).toBe(true);
    expect(page.draft()).not.toBeNull();
    expect(page.saving()).toBe(false);
  });

  it('shows the server field errors instead of a generic failure', () => {
    const invalid = new HttpErrorResponse({
      status: 422,
      error: { error: { code: 'CONTENT_VALIDATION', message: 'Bài viết chưa hợp lệ.', details: { slug: 'Slug đã có bài khác dùng.' } } },
    });
    const { page } = boot({ content: ['read', 'create', 'update'] }, invalid);
    page.openCreate();
    page.draft.set({ ...validDraft });
    page.save();

    expect(page.errors()['slug']).toBe('Slug đã có bài khác dùng.');
    expect(page.draft()).not.toBeNull();
  });

  it('refetches the winning copy before reopening a conflicted post', () => {
    const conflict = new HttpErrorResponse({
      status: 409,
      error: { error: { code: 'VERSION_CONFLICT', message: 'Bài viết vừa được người khác sửa.' } },
    });
    const { page, listCalls } = boot({ content: ['read', 'create', 'update'] }, conflict);
    page.openEdit(POSTS[0]);
    page.save();
    expect(page.conflict()).toBe(true);

    page.reloadConflict();

    expect(listCalls.some((params) => params['q'] === POSTS[0].slug && params['limit'] === '200')).toBe(true);
    expect(page.editing()?.version).toBe(7);
    expect(page.notice()).toContain('Đã tải bản mới nhất');
    expect(page.conflict()).toBe(false);
  });

  it('asks before discarding a dirty draft', () => {
    const { page } = boot();
    page.openCreate();
    page.markDirty();
    page.closeEditor();

    expect(page.discardOpen()).toBe(true);
    expect(page.draft()).not.toBeNull();

    page.cancelDiscard();
    expect(page.draft()).not.toBeNull();

    page.closeEditor();
    page.confirmDiscard();
    expect(page.draft()).toBeNull();
    expect(page.discardOpen()).toBe(false);
  });
});
