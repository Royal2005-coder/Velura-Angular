import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { catchError, forkJoin, of } from 'rxjs';
import { AdminBlogRow, AdminContentCategory, AdminErpApiService } from '../../core/admin-erp-api.service';
import {
  blogRequestBody,
  blogSlugFromTitle,
  blogStatusLabel,
  blogStatusTone,
  blogStatusChoices,
  emptyBlogDraft,
  validateBlogDraft,
  type BlogDraft,
} from '../../core/admin-erp-content';
import { adminDateTime } from '../../core/admin-erp-format';
import {
  adminErrorMessage,
  adminErrorDetails,
  adminListCount,
  adminListRows,
  adminOffset,
  adminRangeLabel,
  type AdminListPayload,
} from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { AdminErpDataTable, AdminTableColumn } from '../../shared/ui/admin-data-table';
import { AdminErpFilterBar } from '../../shared/ui/admin-filter-bar';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminErpKpiCard } from '../../shared/ui/admin-kpi-card';
import { AdminErpModal } from '../../shared/ui/admin-modal';
import { AdminErpPageHeader } from '../../shared/ui/admin-page-header';
import { AdminErpPagination } from '../../shared/ui/admin-pagination';
import { AdminErpTab, AdminErpTabs } from '../../shared/ui/admin-tabs';

type ContentTab = 'all' | 'draft' | 'published' | 'archived';

const EMPTY_BLOGS: AdminListPayload<AdminBlogRow> = { rows: [], count: 0 };
const TABS: readonly ContentTab[] = ['all', 'draft', 'published', 'archived'];

/**
 * CMS workspace for blog content (KAN-106).
 *
 * Only `super_admin` may read or write `content`; everything the editor can still get wrong is
 * blocked here, and the RPC in migration 078 stays the authority — including optimistic locking,
 * which is why a stale editor keeps its text and offers to reload the newer copy instead of
 * silently winning the last write.
 */
@Component({
  selector: 'app-admin-erp-content-page',
  imports: [
    AdminErpPageHeader,
    AdminErpKpiCard,
    AdminErpTabs,
    AdminErpFilterBar,
    AdminErpDataTable,
    AdminErpPagination,
    AdminErpModal,
    AdminErpIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-erp-content.page.html',
  styleUrl: './admin-erp-content.page.scss',
})
export class AdminErpContentPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);

  readonly tab = signal<ContentTab>('all');
  readonly search = signal('');
  readonly rows = signal<AdminBlogRow[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly loading = signal(true);
  readonly hasLoadedOnce = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly counts = signal({ draft: 0, published: 0, archived: 0, categories: 0 });
  readonly categories = signal<AdminContentCategory[]>([]);

  /** Editor state: `null` đóng form; bản đang sửa giữ `editing` để biết version gửi lại. */
  readonly draft = signal<BlogDraft | null>(null);
  readonly editing = signal<AdminBlogRow | null>(null);
  readonly errors = signal<Record<string, string>>({});
  readonly conflict = signal(false);
  readonly saving = signal(false);

  readonly canRead = computed(() => this.session.can('read', 'content'));
  readonly canCreate = computed(() => this.session.can('create', 'content'));
  readonly canUpdate = computed(() => this.session.can('update', 'content'));
  readonly canEdit = computed(() => this.canCreate() || this.canUpdate());

  readonly tabs = computed<readonly AdminErpTab[]>(() => [
    { key: 'all', label: 'Tất cả', count: this.total() },
    { key: 'draft', label: 'Bản nháp', count: this.counts().draft },
    { key: 'published', label: 'Đã công bố', count: this.counts().published },
    { key: 'archived', label: 'Đã lưu trữ', count: this.counts().archived },
  ]);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize, 'bài viết'));
  readonly statusChoices = computed(() => blogStatusChoices(this.editing()?.status, !this.editing()));
  readonly categoryOptions = computed(() => this.categories());
  readonly columns = computed<readonly AdminTableColumn[]>(() => [
    { key: 'title', label: 'Bài viết', value: (row) => (row as AdminBlogRow).title },
    { key: 'slug', label: 'Slug', value: (row) => (row as AdminBlogRow).slug || '—', mono: true },
    { key: 'category', label: 'Danh mục', value: (row) => this.categoryLabel((row as AdminBlogRow).category_slug) },
    {
      key: 'status',
      label: 'Trạng thái',
      value: (row) => blogStatusLabel((row as AdminBlogRow).status),
      badge: (row) => ({ label: blogStatusLabel((row as AdminBlogRow).status), tone: blogStatusTone((row as AdminBlogRow).status) }),
    },
    { key: 'featured', label: 'Nổi bật', value: (row) => ((row as AdminBlogRow).is_featured ? 'Có' : '—') },
    { key: 'read', label: 'Phút đọc', value: (row) => String((row as AdminBlogRow).read_minutes ?? 5), align: 'right', mono: true },
    { key: 'updated', label: 'Sửa lần cuối', value: (row) => this.dateTime((row as AdminBlogRow).updated_at) },
  ]);

  constructor() {
    this.loadCategories();
    this.reload();
  }

  /**
   * Loads the active queue plus the per-status counts the KPI cards and tabs show.
   */
  reload(): void {
    if (!this.canRead()) {
      this.loading.set(false);
      this.rows.set([]);
      this.total.set(0);
      return;
    }
    this.loading.set(true);
    this.loadError.set(null);
    const status = this.tab() === 'all' ? '' : this.tab();
    forkJoin({
      list: this.api.listBlogs({ status, q: this.search(), limit: String(this.pageSize), offset: adminOffset(this.page(), this.pageSize) }).pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không tải được danh sách bài viết.'));
          return of(EMPTY_BLOGS);
        }),
      ),
      draft: this.api.listBlogs({ status: 'draft', limit: '1' }).pipe(catchError(() => of(EMPTY_BLOGS))),
      published: this.api.listBlogs({ status: 'published', limit: '1' }).pipe(catchError(() => of(EMPTY_BLOGS))),
      archived: this.api.listBlogs({ status: 'archived', limit: '1' }).pipe(catchError(() => of(EMPTY_BLOGS))),
    }).subscribe((payload) => {
      this.rows.set(adminListRows(payload.list));
      this.total.set(adminListCount(payload.list));
      this.counts.update((current) => ({
        ...current,
        draft: adminListCount(payload.draft),
        published: adminListCount(payload.published),
        archived: adminListCount(payload.archived),
      }));
      this.loading.set(false);
      this.hasLoadedOnce.set(true);
    });
  }

  /**
   * Reads blog categories once; the RPC refuses a post whose category does not exist.
   */
  private loadCategories(): void {
    this.api
      .listContentCategories('blog')
      .pipe(catchError(() => of({ rows: [] as AdminContentCategory[] })))
      .subscribe((payload) => {
        const rows = payload.rows || [];
        this.categories.set(rows);
        this.counts.update((current) => ({ ...current, categories: rows.length }));
      });
  }

  /**
   * Switches queue tabs.
   */
  setTab(tab: string): void {
    if (!TABS.includes(tab as ContentTab)) return;
    this.tab.set(tab as ContentTab);
    this.page.set(1);
    this.reload();
  }

  /**
   * Applies the server-side title/slug search.
   */
  applyFilters(): void {
    this.page.set(1);
    this.reload();
  }

  resetFilters(): void {
    this.search.set('');
    this.page.set(1);
    this.reload();
  }

  goPage(page: number): void {
    this.page.set(Math.min(this.totalPages(), Math.max(1, page)));
    this.reload();
  }

  onSearchInput(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  /**
   * Opens the editor for a new post.
   */
  openCreate(): void {
    if (!this.canCreate()) return;
    this.notice.set(null);
    this.conflict.set(false);
    this.errors.set({});
    this.editing.set(null);
    this.draft.set({ ...emptyBlogDraft });
  }

  /**
   * Opens the editor for one existing post, carrying its version for optimistic locking.
   */
  openEdit(row: unknown): void {
    const blog = row as AdminBlogRow;
    if (!this.canUpdate()) return;
    this.notice.set(null);
    this.conflict.set(false);
    this.errors.set({});
    this.editing.set(blog);
    this.draft.set({
      slug: blog.slug || '',
      title: blog.title || '',
      categorySlug: blog.category_slug || '',
      status: blog.status || 'draft',
      excerpt: blog.excerpt || '',
      content: blog.content || '',
      imageUrl: blog.image_url || '',
      author: blog.author || 'Velura Editorial',
      readMinutes: Number(blog.read_minutes ?? 5),
      isFeatured: Boolean(blog.is_featured),
    });
  }

  closeEditor(): void {
    this.draft.set(null);
    this.editing.set(null);
    this.errors.set({});
    this.conflict.set(false);
    this.saving.set(false);
  }

  /**
   * Edits one text field of the draft.
   */
  onField(field: 'slug' | 'title' | 'categorySlug' | 'status' | 'excerpt' | 'content' | 'imageUrl' | 'author', event: Event): void {
    const value =
      field === 'excerpt' || field === 'content'
        ? (event.target as HTMLTextAreaElement).value
        : (event.target as HTMLInputElement | HTMLSelectElement).value;
    this.draft.update((draft) => (draft ? { ...draft, [field]: value } : draft));
  }

  /**
   * Edits the numeric and boolean fields of the draft.
   */
  onNumberField(event: Event): void {
    const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
    this.draft.update((draft) => (draft ? { ...draft, readMinutes: Number.isFinite(value) ? value : 0 } : draft));
  }

  onFeaturedChange(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.draft.update((draft) => (draft ? { ...draft, isFeatured: checked } : draft));
  }

  /**
   * Slug from the title, so the operator does not invent a URL for every post.
   */
  suggestSlug(): void {
    const draft = this.draft();
    if (!draft) return;
    this.draft.set({ ...draft, slug: blogSlugFromTitle(draft.title) });
  }

  /**
   * Saves the draft: create for a new post, versioned update for an existing one.
   */
  save(): void {
    const draft = this.draft();
    const editing = this.editing();
    if (!draft || this.saving()) return;
    if (editing && !this.canUpdate()) return;
    if (!editing && !this.canCreate()) return;

    const errors = validateBlogDraft(draft, !!editing);
    this.errors.set(errors);
    if (Object.keys(errors).length) {
      return;
    }

    this.saving.set(true);
    this.conflict.set(false);
    const body = blogRequestBody(draft, editing ? Number(editing.version ?? 0) : undefined);
    const request = editing ? this.api.updateBlog(editing.blog_id, body) : this.api.createBlog(body);
    request.subscribe({
      next: (saved) => {
        this.saving.set(false);
        this.closeEditor();
        this.notice.set(
          editing
            ? `Đã lưu "${saved.title}" (bản ${saved.version}, trạng thái ${blogStatusLabel(saved.status)}).`
            : `Đã tạo "${saved.title}" ở trạng thái ${blogStatusLabel(saved.status)}.`,
        );
        this.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        const code = this.errorCode(error);
        if (code === 'VERSION_CONFLICT' && editing) {
          this.conflict.set(true);
          this.errors.set({});
          return;
        }
        this.errors.set(code === 'CONTENT_VALIDATION' ? this.fieldErrors(error) : {});
        this.notice.set(adminErrorMessage(error, 'Không lưu được bài viết.'));
      },
    });
  }

  /**
   * Reloads the newer copy of a conflicting post into the editor.
   */
  reloadConflict(): void {
    const editing = this.editing();
    if (!editing) return;
    const fresh = this.rows().find((row) => row.blog_id === editing.blog_id) || editing;
    this.openEdit(fresh);
    this.notice.set('Đã tải bản mới nhất vào trình soạn. Nội dung cũ của bạn đã bị ghi đè bởi người khác.');
  }

  /**
   * Category label for a table row.
   */
  categoryLabel(slug: string | undefined): string {
    if (!slug) return '—';
    return this.categories().find((category) => category.slug === slug)?.name || slug;
  }

  statusLabel(status: string | undefined): string {
    return blogStatusLabel(status);
  }

  statusTone(status: string | undefined): 'neutral' | 'success' | 'warning' {
    return blogStatusTone(status);
  }

  dateTime(value: string | undefined | null): string {
    return adminDateTime(value);
  }

  private errorCode(error: unknown): string {
    if (!(error instanceof HttpErrorResponse)) return '';
    const payload = error.error as { error?: { code?: string } | string } | null;
    return typeof payload?.error === 'object' ? payload.error?.code || '' : '';
  }

  private fieldErrors(error: unknown): Record<string, string> {
    const details = adminErrorDetails(error) || {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(details)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }
}
